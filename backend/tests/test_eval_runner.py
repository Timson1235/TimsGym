"""All evaluation tests are offline: token counting and model transport are fake."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock
from urllib.request import Request

from evals.budget import Budget, Limits, EvaluationStopped
from evals.run import GuardedStream, main, evaluate_case, compare
from evals.scenarios import fixture, assertions, DEFAULT_CASES


USAGE = {'input_tokens': 1000, 'output_tokens': 50,
         'cache_creation_input_tokens': 100, 'cache_read_input_tokens': 200}


def request(model='claude-sonnet-5-5', output=1024):
    return Request('https://api.anthropic.com/v1/messages', data=json.dumps({
        'model': model, 'max_tokens': output, 'system': [], 'messages': [], 'tools': []}).encode())


class BudgetTests(unittest.TestCase):
    def test_prices_include_cache_usage(self):
        budget = Budget('claude-sonnet-5-5')
        row = budget.reserve(1300)
        budget.settle(row, USAGE)
        self.assertAlmostEqual(row['estimatedCostUsd'], (2000 + 500 + 250 + 20) / 1_000_000)
        self.assertTrue(row['usageKnown'])

    def test_tiny_budget_stops_before_paid_transport(self):
        budget = Budget('claude-sonnet-5-5', Limits(total_usd=.001))
        paid = Mock()
        guarded = GuardedStream(budget, 'fake', paid, counter=lambda *_: 1000)
        with self.assertRaisesRegex(EvaluationStopped, 'run_cost_limit'):
            guarded(request(), timeout_seconds=10, on_text=lambda _: None)
        paid.assert_not_called()
        self.assertEqual(budget.rounds, [])

    def test_missing_usage_and_transport_failure_keep_reservation(self):
        for transport in [Mock(return_value={'content': []}), Mock(side_effect=TimeoutError('fake'))]:
            budget = Budget('claude-sonnet-5-5')
            with self.assertRaises((EvaluationStopped, TimeoutError)):
                GuardedStream(budget, 'fake', transport, counter=lambda *_: 1000)(request(), timeout_seconds=10, on_text=lambda _: None)
            self.assertGreater(budget.charged, 0)
            self.assertIsNone(budget.rounds[0]['estimatedCostUsd'])
            self.assertEqual(budget.snapshot()['unknownUsageRequests'], 1)

    def test_limits_and_unsupported_models_fail_closed(self):
        for value in [0, -1, float('nan'), float('inf'), 2]:
            with self.assertRaises(ValueError):
                Limits(total_usd=value)
        with self.assertRaises(ValueError):
            Budget('unknown-model')
        for limits, reason in [(Limits(case_calls=1), 'case_call_limit'), (Limits(max_calls=1), 'run_call_limit')]:
            budget = Budget('claude-sonnet-5-5', limits)
            row = budget.reserve(100)
            budget.settle(row, {'input_tokens': 100, 'output_tokens': 1})
            with self.assertRaisesRegex(EvaluationStopped, reason):
                budget.reserve(100)

    def test_time_and_input_caps_block_requests(self):
        clock = Mock(return_value=0)
        budget = Budget('claude-sonnet-5-5', clock=clock)
        clock.return_value = 100
        with self.assertRaisesRegex(EvaluationStopped, 'case_time_limit'):
            budget.reserve(100)
        budget = Budget('claude-sonnet-5-5')
        with self.assertRaisesRegex(EvaluationStopped, 'input_token_limit'):
            budget.reserve(12000)

    def test_wrong_model_output_cap_and_preflight_failure_never_call_transport(self):
        for req, counter in [(request('wrong-model'), lambda *_: 100),
                             (request(output=4096), lambda *_: 100),
                             (request(), Mock(side_effect=RuntimeError('fake')))]:
            paid = Mock()
            with self.assertRaises(EvaluationStopped):
                GuardedStream(Budget('claude-sonnet-5-5'), 'fake', paid, counter=counter)(req, timeout_seconds=10, on_text=lambda _: None)
            paid.assert_not_called()

    def test_success_records_inference_and_does_not_rely_on_app_cost(self):
        def transport(req, *, on_text, timeout_seconds):
            self.assertLessEqual(timeout_seconds, 30)
            on_text('Hello')
            return {'usage': USAGE, 'model': 'claude-sonnet-5-5'}
        budget = Budget('claude-sonnet-5-5')
        events = []
        checkpoint = Mock()
        GuardedStream(budget, 'fake', transport, lambda *_: 1300, checkpoint)(request(), timeout_seconds=45, on_text=events.append)
        self.assertEqual(events, ['Hello'])
        self.assertEqual(checkpoint.call_count, 2)
        self.assertIsNotNone(budget.rounds[0]['inferenceMs'])
        self.assertIsNotNone(budget.rounds[0]['preflightMs'])


class RunnerTests(unittest.TestCase):
    def test_dry_run_has_zero_network_and_no_database(self):
        with patch('evals.run.urlopen', side_effect=AssertionError('network forbidden')) as net, \
                patch('sqlmodel.create_engine', side_effect=AssertionError('database forbidden')) as db, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            code = main([])
        self.assertEqual(code, 0)
        self.assertIn('Dry-run only', output.getvalue())
        self.assertIn('ambiguous_logging', output.getvalue())
        net.assert_not_called()
        db.assert_not_called()
        self.assertEqual(DEFAULT_CASES, ('ambiguous_logging', 'missing_effort', 'repeat_adapt'))

    def test_real_loop_uses_sqlite_fake_transport_and_output_cap(self):
        from app.agent import claude_provider
        from app.config import settings
        calls = []
        def fake_transport(req, *, on_text, timeout_seconds):
            payload = json.loads(req.data)
            calls.append(payload)
            on_text('Which overhead press do you mean: barbell or dumbbell?')
            return {'content': [{'type': 'text', 'text': 'Which overhead press do you mean: barbell or dumbbell?'}],
                    'stop_reason': 'end_turn', 'usage': USAGE}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(claude_provider, '_request_stream', side_effect=fake_transport), \
                patch('evals.run.count_tokens', return_value=1300), \
                patch('evals.run.urlopen', side_effect=AssertionError('network forbidden')):
            record = evaluate_case('ambiguous_logging', Budget('claude-sonnet-5-5'), Path(directory), 'fake-key')
            self.assertEqual(record['status'], 'passed')
            self.assertEqual(calls[0]['max_tokens'], 1024)
            self.assertTrue(all(record['checks'].values()))
            self.assertEqual(record['modelRequests'], 1)
            self.assertTrue((Path(directory) / 'ambiguous_logging.trace.json').exists())
            self.assertTrue((Path(directory) / 'usage.json').exists())
            self.assertTrue((Path(directory) / record['traceFile']).exists())

    def test_budget_abort_is_incomplete_and_cannot_fallback(self):
        from app.agent import claude_provider, coach
        with tempfile.TemporaryDirectory() as directory, \
                patch('evals.run.count_tokens', return_value=1300), \
                patch.object(claude_provider, '_request_stream') as paid, \
                patch.object(coach, '_generate_with_retry') as fallback:
            record = evaluate_case('repeat_adapt', Budget('claude-sonnet-5-5', Limits(total_usd=.001)), Path(directory), 'fake')
        paid.assert_not_called()
        fallback.assert_not_called()
        self.assertEqual(record['status'], 'budget_stopped')
        self.assertEqual(record['modelRequests'], 0)
        self.assertFalse(record['checks']['completed'])

    def test_cli_stops_suite_and_preserves_report_on_low_budget(self):
        from app.config import settings
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(settings, 'CLAUDE_API_KEY', 'fake'), \
                patch('evals.run.count_tokens', return_value=1300), \
                patch('evals.run.urlopen', side_effect=AssertionError('paid inference forbidden')), \
                contextlib.redirect_stdout(io.StringIO()):
            output = Path(directory) / 'run'
            self.assertEqual(main(['--live', '--max-cost', '0.001', '--output', str(output)]), 1)
            report = json.loads((output / 'report.json').read_text())
            self.assertEqual(report['cases'][0]['status'], 'budget_stopped')
            self.assertEqual(len(report['notRunCases']), 2)
            self.assertTrue((output / 'report.md').exists())

    def test_comparison_flags_different_settings(self):
        old = {'model': 'claude-sonnet-5-5', 'limits': {}, 'fixtureVersion': 'v1', 'cases': [
            {'case': 'a', 'status': 'failed', 'wallMs': 100, 'inferenceMs': 90, 'estimatedCostUsd': .01, 'checks': {'one': False}}]}
        new = {'model': 'claude-sonnet-5-5', 'limits': {'different': True}, 'fixtureVersion': 'v1', 'cases': [
            {'case': 'a', 'status': 'passed', 'wallMs': 50, 'inferenceMs': 40, 'estimatedCostUsd': .005, 'checks': {'one': True}}]}
        result = compare(new, old)[0]
        self.assertFalse(result['comparableSettings'])
        self.assertEqual(result['wallMsDelta'], -50)
        self.assertEqual(result['afterChecksPassed'], 1)

    def test_grade_rejects_fake_success_and_foreign_reference(self):
        empty = {'reply': 'Ready', 'trace': {'terminationReason': 'completed'}}
        checks = assertions('repeat_adapt', empty, None, [])
        self.assertFalse(checks['preview_created'])
        self.assertFalse(checks['correct_reference_retrieved'])
        self.assertFalse(checks['separate_press_history'])
        checks = assertions('repeat_adapt', empty, None, [{'tool': 'get_session_summary', 'result': {'sessions': [{'id': 'foreign-full'}]}}])
        self.assertFalse(checks['correct_reference_retrieved'])

    def test_repeat_workflow_is_graded_from_real_local_tool_results(self):
        from app.agent import claude_provider
        from tests.test_tool_discovery import response, call
        def batch(key, tool, **arguments):
            return {'key': key, 'tool': tool, 'arguments': arguments}
        rounds = iter([
            response(call('discover_tools', {'names': ['batch_retrieve', 'start_workout_session']})),
            response(call('batch_retrieve', {'requests': [
                batch('ref', 'get_session_summary', search_title_or_date='full body', limit=1, include_details=True),
                batch('press', 'get_exercise_history', exercise_id='press', limit=1),
            ]})),
            response(call('batch_retrieve', {'requests': [
                batch('squat', 'suggest_weight', exercise_id='squat'),
                batch('press', 'suggest_weight', exercise_id='press'),
                batch('row', 'suggest_weight', exercise_id='row'),
            ]})),
            response(call('start_workout_session', {'title': 'Full Body B', 'exercises': [
                {'exerciseName': name, 'sets': [{'weight': weight, 'reps': 8, 'setType': 'working'}] * count}
                for name, weight, count in [('Barbell Back Squat', 40, 2), ('Barbell Overhead Press', 20, 3), ('Barbell Row', 30, 2)]
            ]})),
            response(text='The full-body preview is ready with one additional press set and unchanged working weights.'),
        ])
        def transport(req, *, on_text, timeout_seconds):
            result = next(rounds)
            result['usage'] = USAGE
            for block in result['content']:
                if block['type'] == 'text':
                    on_text(block['text'])
            return result
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(claude_provider, '_request_stream', side_effect=transport), \
                patch('evals.run.count_tokens', return_value=1300), \
                patch('evals.run.urlopen', side_effect=AssertionError('network forbidden')):
            record = evaluate_case('repeat_adapt', Budget('claude-sonnet-5-5'), Path(directory), 'fake')
        self.assertEqual(record['status'], 'passed', record['checks'])
        self.assertEqual(record['modelRequests'], 5)
        self.assertTrue(all(record['checks'].values()))
        self.assertIsNotNone(record['timeToFirstTextMs'])

    def test_missing_effort_uses_evidence_and_remains_unchanged(self):
        from app.agent import claude_provider
        from tests.test_tool_discovery import response, call
        rounds = iter([
            response(call('discover_tools', {'names': ['batch_retrieve']})),
            response(call('batch_retrieve', {'requests': [
                {'key': 'squat', 'tool': 'suggest_weight', 'arguments': {'exercise_id': 'squat'}},
            ]})),
            response(text='Keep 40 kg for now: reported effort is missing, so hold the target.'),
        ])
        def transport(req, *, on_text, timeout_seconds):
            result = next(rounds)
            result['usage'] = USAGE
            return result
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(claude_provider, '_request_stream', side_effect=transport), \
                patch('evals.run.count_tokens', return_value=1300), \
                patch('evals.run.urlopen', side_effect=AssertionError('network forbidden')):
            record = evaluate_case('missing_effort', Budget('claude-sonnet-5-5'), Path(directory), 'fake')
        self.assertEqual(record['status'], 'passed', record['checks'])
        self.assertEqual(record['modelRequests'], 3)

    def test_leg_browsing_follows_actual_cursor_then_fetches_only_selected_details(self):
        from app.agent import claude_provider
        from tests.test_tool_discovery import response, call
        calls = []
        def transport(req, *, on_text, timeout_seconds):
            payload = json.loads(req.data)
            index = len(calls)
            calls.append(payload)
            if index == 0:
                result = response(call('discover_tools', {'names': ['get_session_summary', 'get_workout_details']}))
            elif index == 1:
                result = response(call('get_session_summary', {'limit': 3}))
            elif index == 2:
                data = json.loads(payload['messages'][-1]['content'][0]['content'])
                self.assertTrue(data['hasMore'])
                self.assertNotIn('leg-reference', [w['id'] for w in data['sessions']])
                result = response(call('get_session_summary', {'limit': 3, 'cursor': data['nextCursor']}))
            elif index == 3:
                data = json.loads(payload['messages'][-1]['content'][0]['content'])
                self.assertIn('leg-reference', [w['id'] for w in data['sessions']])
                result = response(call('get_workout_details', {'workout_id': 'leg-reference'}))
            else:
                data = json.loads(payload['messages'][-1]['content'][0]['content'])
                self.assertEqual(data['workout']['notes'], 'Finished with time to spare.')
                self.assertEqual(data['workout']['durationMinutes'], 40)
                result = response(text='Session B on 2026-10-10: Barbell Back Squat: warm-up 10 kg x 5; working 40 kg x 8 twice. Romanian Deadlift: working 60 kg x 6 twice. Working sets RIR 2; warm-up RIR unknown. Controlled descent. Finished with time to spare.')
            result['usage'] = USAGE
            return result
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(claude_provider, '_request_stream', side_effect=transport), \
                patch('evals.run.count_tokens', return_value=1300), \
                patch('evals.run.urlopen', side_effect=AssertionError('network forbidden')):
            record = evaluate_case('leg_session_browse', Budget('claude-sonnet-5-5'), Path(directory), 'fake')
        self.assertEqual(record['status'], 'passed', record['checks'])
        self.assertEqual(record['modelRequests'], 5)

    def test_leg_browsing_grade_does_not_pass_without_page_and_detail_evidence(self):
        result = {'reply': 'Squat and Romanian Deadlift 10 40 60 warm-up working RIR controlled descent time to spare',
                  'trace': {'terminationReason': 'completed'}}
        checks = assertions('leg_session_browse', result, None, [])
        self.assertFalse(checks['followed_cursor'])
        self.assertFalse(checks['found_candidate'])
        self.assertFalse(checks['selected_exact_details'])
        self.assertFalse(checks['details_after_browsing'])
