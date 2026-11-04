"""Run from backend/: python -m evals.run [--live] [--case repeat_adapt]."""
import argparse
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime
import hashlib
import json
from pathlib import Path
import ssl
import subprocess
import time
from unittest.mock import patch
from urllib.request import Request, urlopen
from uuid import uuid4

from .budget import Budget, Limits, EvaluationStopped, PRICES
from .scenarios import CASES, DEFAULT_CASES, FIXED_NOW, FIXTURE_VERSION, fixture, assertions


ROOT = Path(__file__).resolve().parents[2]


def count_tokens(payload, api_key, timeout):
    import certifi
    body = {key: payload[key] for key in ('model', 'system', 'messages', 'tools') if key in payload}
    request = Request('https://api.anthropic.com/v1/messages/count_tokens',
                      data=json.dumps(body).encode(), method='POST', headers={
                          'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                          'content-type': 'application/json'})
    with urlopen(request, timeout=timeout, context=ssl.create_default_context(cafile=certifi.where())) as response:
        return json.load(response)['input_tokens']


class GuardedStream:
    def __init__(self, budget, api_key, transport, counter=None, checkpoint=None):
        self.budget, self.api_key, self.transport, self.counter = budget, api_key, transport, counter or count_tokens
        self.checkpoint = checkpoint or (lambda: None)

    def __call__(self, request, *, timeout_seconds, on_text):
        budget = self.budget
        budget.check_time()
        payload = json.loads(request.data)
        if payload.get('model') != budget.model:
            budget.stop('unexpected_model')
        if not 0 < payload.get('max_tokens', 0) <= budget.limits.max_output_tokens:
            budget.stop('output_token_limit')
        preflight_start = time.perf_counter()
        remaining = min(budget.limits.total_seconds - (budget.clock() - budget.started),
                        budget.limits.case_seconds - (budget.clock() - budget.case_started))
        try:
            tokens = self.counter(payload, self.api_key, max(0.1, min(10, remaining)))
        except Exception as error:
            budget.stop(f'token_preflight_failed:{type(error).__name__}')
        row = budget.reserve(tokens)
        row['preflightMs'] = round((time.perf_counter() - preflight_start) * 1000)
        self.checkpoint()
        start = time.perf_counter()
        def emit(text):
            budget.check_time()
            on_text(text)
        try:
            remaining = min(budget.limits.total_seconds - (budget.clock() - budget.started),
                            budget.limits.case_seconds - (budget.clock() - budget.case_started))
            result = self.transport(request, timeout_seconds=max(0.1, min(timeout_seconds, 30, remaining)), on_text=emit)
            row['responseModel'] = result.get('model')
            budget.settle(row, result.get('usage'))
            return result
        except Exception as error:
            row['errorType'] = type(error).__name__
            if budget.stop_reason is None:
                budget.stop_reason = f'provider_error:{type(error).__name__}'
            raise
        finally:
            row['inferenceMs'] = round((time.perf_counter() - start) * 1000)
            self.checkpoint()


def provenance():
    digest = hashlib.sha256()
    for directory in ('app/agent', 'app/memory', 'evals'):
        for path in sorted((ROOT / 'backend' / directory).glob('*.py')):
            digest.update(str(path.relative_to(ROOT)).encode())
            digest.update(path.read_bytes())
    try:
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        commit, dirty = None, None
    return {'gitCommit': commit, 'workingTreeDirty': dirty, 'codeFingerprint': digest.hexdigest(),
            'fixtureVersion': FIXTURE_VERSION, 'fixedNow': FIXED_NOW}


def seed(engine, name):
    from sqlmodel import Session, SQLModel
    from app.models import User, Profile, Exercise, Workout
    db, active = fixture(name)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        user = User(id=1, uid='synthetic-eval', email='eval@example.invalid')
        session.add(user)
        session.add(Profile(user_id=1, name=db['profile']['name'], preferred_unit='kg',
                            experience_level='Intermediate', primary_goal='General Fitness',
                            personal_memories=db['profile']['personalMemories']))
        for exercise in db['exercises']:
            session.add(Exercise(id=exercise['id'], user_id=1, name=exercise['name'],
                                 category=exercise['category'], equipment=exercise['equipment']))
        for workout in db['workouts']:
            session.add(Workout(id=workout['id'], user_id=1, title=workout['title'], date=workout['date'],
                                is_completed=workout['isCompleted'], exercises_data=workout['exercises'],
                                duration_minutes=workout.get('durationMinutes', 0),
                                total_volume=workout.get('totalVolume', 0), notes=workout.get('notes')))
        # Cross-account decoy: a newer matching title must never be retrieved.
        session.add(User(id=2, uid='synthetic-other', email='other@example.invalid'))
        session.add(Workout(id='foreign-full', user_id=2, title='Full Body', date='2026-10-23',
                            is_completed=True, exercises_data=[]))
        session.commit()
    return active


def collect_reads(trace):
    reads = []
    for span in trace['spans']:
        if span['status'] != 'completed':
            continue
        output = trace.get('payloads', {}).get(span.get('output_payload_id'), {})
        if span['kind'] == 'retrieval' and isinstance(output, dict) and output.get('success'):
            if 'result' in output:
                reads.append({'tool': span['name'], 'result': output['result'],
                              'sequence': span['sequence'], 'arguments': trace.get('payloads', {}).get(span.get('input_payload_id'), {}).get('arguments', {})})
        elif span['kind'] == 'tool' and span['name'] in {'get_session_summary', 'get_exercise_history', 'suggest_weight', 'get_workout_details'}:
            if isinstance(output, dict) and isinstance(output.get('result'), dict):
                reads.append({'tool': span['name'], 'result': output['result'],
                              'sequence': span['sequence'], 'arguments': trace.get('payloads', {}).get(span.get('input_payload_id'), {}).get('arguments', {})})
    return reads


def evaluate_case(name, budget, output, api_key):
    from sqlmodel import Session, create_engine
    from app import tracing, crud, db as app_db
    from app.agent import coach, claude_provider
    from app.config import settings
    from app.models import User
    from app.memory import summary
    from app.agent.prompts import PROMPT_VERSION

    database = output / f'{name}.sqlite3'
    engine = create_engine(f'sqlite:///{database}')
    active = seed(engine, name)
    with Session(engine) as session:
        initial_training_state = crud.get_user_database_state(session, 1)
    original = deepcopy(active)
    budget.begin_case(name)
    start_round = len(budget.rounds)
    trace_id = f'eval-{name}-{uuid4().hex}'
    original_agent = coach.run_claude_agent
    def checkpoint():
        (output / 'usage.json').write_text(json.dumps({**budget.snapshot(), 'rounds': budget.rounds}, indent=2))
    guarded = GuardedStream(budget, api_key, claude_provider._request_stream, checkpoint=checkpoint)
    result, error_type = {}, None
    class FixedClock:
        @staticmethod
        def now(tz=None):
            value = datetime.fromisoformat(FIXED_NOW)
            return value.astimezone(tz) if tz else value
    def run_agent(**kwargs):
        return original_agent(**kwargs, max_output_tokens=budget.limits.max_output_tokens)
    started = time.perf_counter()
    try:
        with ExitStack() as stack:
            # Only transport is wrapped. Context assembly, tool execution, memory
            # reads/writes, streaming and traces use the production implementation.
            stack.enter_context(patch.object(app_db, 'engine', engine))
            stack.enter_context(patch.object(coach, '_client', None))
            stack.enter_context(patch.object(summary, '_client', None))
            stack.enter_context(patch.object(settings, 'CLAUDE_API_KEY', api_key))
            stack.enter_context(patch.object(settings, 'CLAUDE_MODEL', budget.model))
            stack.enter_context(patch.object(settings, 'GEMINI_API_KEY', ''))
            stack.enter_context(patch.object(coach, 'datetime', FixedClock))
            stack.enter_context(patch.object(coach, 'run_claude_agent', side_effect=run_agent))
            stack.enter_context(patch.object(claude_provider, '_request_stream', side_effect=guarded))
            stack.enter_context(patch.object(coach.summary_jobs, 'enqueue_if_needed', return_value=False))
            # Any unexpected non-streamed generation is refused, never unbudgeted.
            stack.enter_context(patch.object(claude_provider, '_request_json', side_effect=EvaluationStopped('unexpected_nonstream_request')))
            with Session(engine) as session, tracing.request_trace(engine, trace_id, 1, name):
                result = coach.run_chat(session, User(id=1, uid='synthetic-eval', email='eval@example.invalid'),
                    CASES[name]['message'], active, thread_id=name, request_id=trace_id, on_event=lambda event: None)
    except Exception as error:
        error_type = type(error).__name__
    elapsed = round((time.perf_counter() - started) * 1000)
    with Session(engine) as session:
        trace = tracing.read_trace(session, 1, trace_id, True) or {'spans': [], 'payloads': {}}
        final_training_state = crud.get_user_database_state(session, 1)
    engine.dispose()
    reads = collect_reads(trace)
    checks = assertions(name, result, original, reads)
    # These scenarios change only active state or create a preview, not saved
    # workouts, exercise identities or profiles. Chat/trace persistence is allowed.
    checks['persistent_training_state_unchanged'] = initial_training_state == final_training_state
    rows = deepcopy(budget.rounds[start_round:])
    status = ('budget_stopped' if budget.stop_reason and not budget.stop_reason.startswith('provider_error')
              else 'error' if error_type or budget.stop_reason else 'passed' if all(checks.values()) else 'failed')
    record = {'case': name, 'status': status, 'message': CASES[name]['message'], 'checks': checks,
              'manualReview': {'scientificSoundness': None, 'languageAndClarity': None, 'notes': ''},
              'promptVersion': PROMPT_VERSION, 'wallMs': elapsed,
              'timeToFirstTextMs': result.get('trace', {}).get('firstTextMs'),
              'readCache': result.get('trace', {}).get('readCache'),
              'inferenceMs': sum(row['inferenceMs'] or 0 for row in rows),
              'tokenPreflightMs': sum(row['preflightMs'] or 0 for row in rows),
              'modelRequests': len(rows), 'rounds': rows, 'traceId': trace_id,
              'traceFile': database.name, 'errorType': error_type,
              'terminationReason': result.get('trace', {}).get('terminationReason'),
              'budgetStopReason': budget.stop_reason, 'reply': result.get('reply'),
              'actions': result.get('actionsExecuted', []),
              'estimatedCostUsd': sum(row['estimatedCostUsd'] or 0 for row in rows) if all(row['usageKnown'] for row in rows) else None,
              'budgetAccountedUsd': sum(row['budgetChargeUsd'] for row in rows)}
    # These are synthetic eval traces only, never fetched from the app's database.
    (output / f'{name}.trace.json').write_text(json.dumps(trace, ensure_ascii=False, indent=2))
    return record


def compare(report, baseline):
    previous = {case['case']: case for case in baseline.get('cases', [])}
    result = []
    comparable = all(report.get(key) == baseline.get(key) for key in ('model', 'limits', 'fixtureVersion', 'ratesPerMillionTokensUsd'))
    for case in report['cases']:
        old = previous.get(case['case'])
        if old:
            result.append({'case': case['case'], 'comparableSettings': comparable,
                           'beforeStatus': old['status'], 'afterStatus': case['status'],
                           'wallMsDelta': case['wallMs'] - old['wallMs'],
                           'inferenceMsDelta': case['inferenceMs'] - old.get('inferenceMs', 0),
                           'beforeChecksPassed': sum(old.get('checks', {}).values()),
                           'afterChecksPassed': sum(case['checks'].values()),
                           'costUsdDelta': None if case['estimatedCostUsd'] is None or old.get('estimatedCostUsd') is None
                           else case['estimatedCostUsd'] - old['estimatedCostUsd']})
    return result


def write_report(report, output):
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    lines = ['# Small agent evaluation', '', f"Model: `{report['model']}`. One repetition per case; no model judge.", '',
             '| Case | Status | Checks | Inference | Total incl. preflight | Estimated cost |',
             '| --- | --- | --- | --- | --- | --- |']
    for case in report['cases']:
        cost = f"${case['estimatedCostUsd']:.5f}" if case['estimatedCostUsd'] is not None else 'unknown'
        checks = case['checks']
        lines.append(f"| {case['case']} | {case['status']} | {sum(checks.values())}/{len(checks)} | {case['inferenceMs']/1000:.2f}s | {case['wallMs']/1000:.2f}s | {cost} |")
    lines += ['', 'Checks cover specified behavior, not a scientific accuracy score. Review the saved replies and synthetic traces manually.',
              '', f"Budget-accounted cost: ${report['budgetAccountedUsd']:.5f}. Unknown usage retains its reservation.",
              f"Stop reason: {report.get('stopReason') or 'none'}.",
              f"Not run: {', '.join(report.get('notRunCases', [])) or 'none'}.",
              '', 'Token preflight is free but adds latency; its time is reported separately. Cache state is not controlled.',
              'Prices and token reservations are estimates, not a provider-enforced billing cap.']
    if report.get('comparison'):
        lines += ['', '## Baseline comparison', '', '```json', json.dumps(report['comparison'], indent=2), '```']
    (output / 'report.md').write_text('\n'.join(lines) + '\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Opt in to paid inference; otherwise print a free dry-run plan.')
    parser.add_argument('--case', action='append', choices=list(CASES), dest='cases')
    parser.add_argument('--model', choices=list(PRICES), default='claude-sonnet-5-5')
    parser.add_argument('--max-cost', type=float, default=0.25)
    parser.add_argument('--max-case-cost', type=float, default=0.18)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--baseline', type=Path, help='Previous report.json to compare.')
    args = parser.parse_args(argv)
    try:
        limits = Limits(total_usd=args.max_cost, case_usd=args.max_case_cost)
        budget = Budget(args.model, limits)
    except ValueError as error:
        parser.error(str(error))
    cases = list(dict.fromkeys(args.cases or DEFAULT_CASES))
    baseline = json.loads(args.baseline.read_text()) if args.baseline else None
    manifest = {**provenance(), **budget.snapshot(), 'live': args.live,
                'cases': [{'case': name, **CASES[name]} for name in cases]}
    if not args.live:
        print(json.dumps(manifest, indent=2))
        print('Dry-run only: no API requests, database connections or paid inference. Add --live to execute.')
        return 0
    from app.config import settings
    if not settings.CLAUDE_API_KEY:
        parser.error('CLAUDE_API_KEY is missing. Run from backend/ with the project .env configured.')
    output = args.output or Path(__file__).parent / 'results' / f'{datetime.now().strftime("%Y%m%d-%H%M%S")}-{uuid4().hex[:6]}'
    if output.exists():
        parser.error('Output directory already exists; choose a new directory to preserve prior reports.')
    output.mkdir(parents=True)
    report = {**provenance(), **budget.snapshot(), 'live': True, 'cases': [],
              'cacheConditions': 'Uncontrolled provider cache; reads/writes recorded per request.',
              'comparison': []}
    for name in cases:
        if budget.stop_reason:
            break
        print(f'Running {name}…', flush=True)
        record = evaluate_case(name, budget, output, settings.CLAUDE_API_KEY)
        report['cases'].append(record)
        report.update(budget.snapshot())
        if baseline:
            report['comparison'] = compare(report, baseline)
        write_report(report, output)  # Persist after each case, not just on success.
        print(f"  {record['status']}: {record['modelRequests']} model requests, budget-accounted ${record['budgetAccountedUsd']:.5f}", flush=True)
    report['notRunCases'] = [name for name in cases if name not in {case['case'] for case in report['cases']}]
    write_report(report, output)
    print(f'Report: {output / "report.md"}')
    return 0 if report['cases'] and all(case['status'] == 'passed' for case in report['cases']) and not report['notRunCases'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
