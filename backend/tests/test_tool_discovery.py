"""Synthetic end-to-end tests of lazy native tools on both provider loops."""
import json
import unittest
from contextlib import ExitStack
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import patch

from google.genai import types

from app.agent import coach, claude_provider
from app.agent.prompts import build_system_instruction, serialize_context, mode_for
from app.agent.tool_registry import ToolSession, REGISTRY, RoundBudget, validation_schema
from jsonschema import Draft202012Validator


def call(name, args, ident='call'):
    return {'type': 'tool_use', 'id': ident, 'name': name, 'input': args}


def response(*calls, text='Done'):
    return {'content': list(calls) or [{'type': 'text', 'text': text}],
            'stop_reason': 'tool_use' if calls else 'end_turn'}


LIBRARY = [{'id': 'squat', 'name': 'Barbell Back Squat', 'category': 'Legs'},
           {'id': 'press', 'name': 'Barbell Overhead Press', 'category': 'Shoulders'}]


def workout(ident, title, ex, date):
    return {'id': ident, 'title': title, 'date': date, 'isCompleted': True,
            'exercises': [{'exerciseId': ex['id'], 'exerciseName': ex['name'],
                           'sets': [{'weight': 40, 'reps': 6, 'type': 'working', 'completed': True, 'rpe': 8}]}]}


class RegistryTests(unittest.TestCase):
    def test_core_and_discovery_are_request_local_and_freeze_each_round(self):
        session = ToolSession(True)
        self.assertEqual(session.names(), ['correct_log', 'discover_tools', 'log_set', 'resolve_exercise'])
        session.declarations()
        session.discover(['get_session_summary', 'get_exercise_history'])
        with self.assertRaisesRegex(ValueError, 'inactive'):
            session.validate('get_session_summary', {})
        session.declarations()
        self.assertTrue(session.validate('get_session_summary', {}).read_only)
        self.assertEqual(ToolSession(False).names(), ['discover_tools'])
        with self.assertRaisesRegex(ValueError, 'Unknown'):
            session.discover(['does_not_exist'])

    def test_validation_rejects_missing_unknown_invalid_and_nested_arguments(self):
        session = ToolSession(True)
        valid = {'exercise_name': 'Barbell Back Squat', 'weight': 40, 'reps': 6}
        session.validate('log_set', valid)
        for args in [{}, {**valid, 'weight': 'forty'}, {**valid, 'reps': True},
                     {**valid, 'rir': None}, {**valid, 'surprise': 1}, {**valid, 'weight': float('nan')},
                     {**valid, 'set_type': 'invented'}]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                session.validate('log_set', args)
        session.discover(['start_workout_session'])
        session.declarations()
        with self.assertRaisesRegex(ValueError, 'required'):
            session.validate('start_workout_session', {'title': 'Test', 'exercises': [{'exerciseName': 'Squat'}]})
        with self.assertRaisesRegex(ValueError, 'Unknown'):
            session.validate('unknown', {})
        for spec in REGISTRY.values():
            Draft202012Validator.check_schema(validation_schema(spec.declaration['parameters']))

    def test_round_budget_reserves_two_discovery_rounds_and_six_work_rounds(self):
        budget = RoundBudget()
        for names in [['discover_tools'], ['get_session_summary'], ['discover_tools'], ['suggest_weight'], ['log_set']]:
            budget.record(names)
            self.assertFalse(budget.exhausted)
        budget.record(['suggest_weight'])
        budget.record(['start_workout_session'])
        self.assertFalse(budget.exhausted)
        budget.record([])
        self.assertTrue(budget.exhausted)
        budget = RoundBudget()
        for _ in range(3):
            budget.record(['discover_tools'])
        self.assertTrue(budget.exhausted)


class PromptTests(unittest.TestCase):
    def test_history_is_absent_and_all_personal_memory_and_summary_are_present(self):
        db = {'profile': {'name': 'Synthetic', 'preferredUnit': 'lbs', 'personalMemories': ['First fact', 'Second fact'],
                          'openFlags': [{'id': 'flag', 'note': 'Temporary limitation', 'date': '2026-10-23'}]},
              'workouts': [{'title': 'UNRELATED HISTORY', 'weight': 98765}]}
        prompt = build_system_instruction(db, None, 'Synthetic conversation summary')
        self.assertNotIn('UNRELATED HISTORY', prompt)
        self.assertNotIn('98765', prompt)
        self.assertIn('First fact', prompt)
        self.assertIn('Second fact', prompt)
        self.assertIn('Synthetic conversation summary', prompt)
        self.assertIn('Temporary limitation', prompt)
        self.assertIn('conservative starting estimate', prompt)
        self.assertIn('MODE: GENERAL COACHING', prompt)
        self.assertNotIn('MODE: ACTIVE WORKOUT', prompt)
        self.assertNotIn('usually German', prompt)
        self.assertNotIn('handstand', prompt)
        self.assertNotIn('"parameters"', prompt)

    def test_full_active_workout_separates_pending_actual_and_original_plans(self):
        state = {'id': 'active', 'date': '2026-10-23', 'notes': 'Workout note', 'exercises': [
            {'exerciseId': 'squat', 'notes': 'Exercise cue', 'sets': [
                {'weight': 45, 'reps': 5, 'type': 'working', 'completed': True, 'rpe': None,
                 'planned': {'weight': 40, 'reps': 6, 'type': 'working', 'rir': 2}},
                {'weight': 40, 'reps': 6, 'type': 'working', 'completed': False, 'rpe': 8},
                {'weight': 20, 'reps': 5, 'type': 'warmup', 'completed': True, 'rpe': 7},
            ]}, {'exerciseId': 'press', 'sets': []}]}
        original = deepcopy(state)
        result = serialize_context({}, state)['activeWorkout']
        self.assertEqual(len(result['exercises']), 2)
        sets = result['exercises'][0]['sets']
        self.assertEqual(len(sets), 3)
        self.assertEqual(sets[0]['planned']['weight'], 40)
        self.assertEqual(sets[0]['actual']['weight'], 45)
        self.assertIsNone(sets[0]['actual']['rir'])
        self.assertIsNone(sets[1]['actual'])
        self.assertEqual(sets[1]['planned']['reps'], 6)
        self.assertIsNone(sets[2]['planned'])
        self.assertEqual(sets[2]['actual']['rir'], 3)
        self.assertEqual(state, original)
        self.assertEqual(mode_for({'id': 'empty', 'exercises': []}), 'active_workout')
        self.assertIn('MODE: ACTIVE WORKOUT', build_system_instruction({}, {'exercises': []}))


class ProviderDiscoveryTests(unittest.TestCase):
    def run_loop(self, provider, responses, active=None, db=None, fail_claude=False, streaming=False):
        db = deepcopy(db or {'profile': {'personalMemories': ['Synthetic fact']}, 'exercises': LIBRARY, 'workouts': []})
        payloads = []
        replies = iter(deepcopy(responses))

        def claude_request(request, **kwargs):
            if kwargs.get('on_text'):
                kwargs['on_text']('Synthetic streamed text')
            payloads.append(json.loads(request.data))
            return next(replies)

        def gemini_request(client, **kwargs):
            payloads.append({'toolConfig': kwargs['config'].tool_config.model_dump(exclude_none=True), 'tools': [d.model_dump(exclude_none=True) for d in kwargs['config'].tools[0].function_declarations],
                             'contents': [c.model_dump(exclude_none=True) for c in kwargs['contents']]})
            result = next(replies)
            calls = [c for c in result['content'] if c['type'] == 'tool_use']
            parts = [types.Part.from_function_call(name=c['name'], args=c['input']) for c in calls]
            if not parts:
                parts = [types.Part(text=result['content'][0]['text'])]
            return types.GenerateContentResponse(candidates=[types.Candidate(content=types.Content(role='model', parts=parts))])

        with ExitStack() as stack:
            for target, replacement in [
                ('app.agent.coach.crud.get_user_database_state', db),
                ('app.agent.coach.summ.read_coach_context', ([], '')),
                ('app.agent.coach.summary_jobs.enqueue_if_needed', False),
            ]:
                stack.enter_context(patch(target, return_value=replacement))
            stack.enter_context(patch.object(coach.settings, 'CLAUDE_API_KEY', 'test' if provider == 'claude' or fail_claude else ''))
            stack.enter_context(patch.object(coach, '_client', object()))
            stack.enter_context(patch.object(coach.memory, 'write_message'))
            stack.enter_context(patch.object(coach.memory, 'write_tool_log'))
            stack.enter_context(patch.object(claude_provider, '_request_json', side_effect=claude_request))
            stack.enter_context(patch.object(claude_provider, '_request_stream', side_effect=claude_request))
            stack.enter_context(patch.object(coach, '_generate_with_retry', side_effect=gemini_request))
            if fail_claude:
                def failed(**kwargs):
                    kwargs['handle_tool']('discover_tools', {'names': ['get_session_summary']}, 'discovery')
                    raise TimeoutError('synthetic timeout after read-only discovery')
                stack.enter_context(patch.object(coach, 'run_claude_agent', side_effect=failed))
            result = coach.run_chat(None, SimpleNamespace(id=1), 'Synthetic request', deepcopy(active), on_event=(lambda event: None) if streaming else None)
        return result, payloads

    def test_discover_parallel_retrieval_and_workout_preview_on_both_providers(self):
        db = {'profile': {}, 'exercises': LIBRARY, 'workouts': [
            workout('full', 'Full body', LIBRARY[0], '2026-10-20'),
            workout('press-day', 'Shoulders', LIBRARY[1], '2026-10-22')]}
        rounds = [
            response(call('discover_tools', {'names': ['get_session_summary', 'get_exercise_history', 'suggest_weight', 'start_workout_session']})),
            response(call('get_session_summary', {'search_title_or_date': 'full body', 'include_details': True, 'limit': 1}, 'session'),
                     call('get_exercise_history', {'exercise_id': 'press', 'limit': 1}, 'exercise')),
            response(call('suggest_weight', {'exercise_id': 'squat'})),
            response(call('start_workout_session', {'title': 'Full body with press', 'exercises': [
                {'exerciseName': 'Barbell Back Squat', 'sets': [{'weight': 40, 'reps': 6, 'setType': 'working'}]},
                {'exerciseName': 'Barbell Overhead Press', 'sets': [{'weight': 40, 'reps': 6, 'setType': 'working'}]}]})),
            response(text='Preview ready, using 2026-10-20 and separate press history.'),
        ]
        for provider in ['claude', 'gemini']:
            with self.subTest(provider=provider):
                result, payloads = self.run_loop(provider, rounds, db=db)
                self.assertEqual(len(payloads), 5)
                self.assertEqual([t['name'] for t in payloads[0]['tools']], ['discover_tools'])
                self.assertIn('get_session_summary', [t['name'] for t in payloads[1]['tools']])
                self.assertEqual(result['actionExecuted']['type'], 'workout_proposed')
                self.assertIn('2026-10-20', result['reply'])
                self.assertEqual(len(result['actionExecuted']['data']['exercises']), 2)
                serialized = json.dumps(payloads[2])
                self.assertIn('press-day', serialized)
                self.assertIn('2026-10-20', serialized)
                self.assertEqual(len(result['trace']['toolDiscovery']), 1)

    def test_logging_has_no_discovery_and_unknown_effort_stays_unknown(self):
        for provider in ['claude', 'gemini']:
            with self.subTest(provider=provider):
                result, payloads = self.run_loop(provider, [
                    response(call('log_set', {'exercise_name': 'Barbell Back Squat', 'weight': 40, 'reps': 6})), response()],
                    active={'id': 'active', 'exercises': []})
                self.assertEqual(len(payloads), 2)
                self.assertEqual(result['toolsUsed'], ['log_set'])
                self.assertIsNone(result['activeWorkoutState']['exercises'][0]['sets'][0]['rpe'])
                self.assertEqual(result['trace']['promptMode'], 'active_workout')

    def test_same_round_activation_and_bad_arguments_cannot_mutate(self):
        for provider in ['claude', 'gemini']:
            with self.subTest(provider=provider):
                result, payloads = self.run_loop(provider, [
                    response(call('discover_tools', {'names': ['log_set']}, 'discover'),
                             call('log_set', {'exercise_name': 'Barbell Back Squat', 'weight': 40, 'reps': 6}, 'premature')),
                    response(call('log_set', {'exercise_name': 'Barbell Back Squat', 'weight': 'bad', 'reps': 6}, 'invalid')),
                    response()], active=None)
                self.assertEqual(result['actionsExecuted'], [])
                self.assertIn('inactive', json.dumps(payloads[1]))
                self.assertIn('not of type', json.dumps(payloads[2]))

    def test_streaming_claude_keeps_dynamic_discovery_and_native_schemas(self):
        result, payloads = self.run_loop('claude', [
            response(call('discover_tools', {'names': ['get_session_summary']})),
            response(call('get_session_summary', {'limit': 1})), response(text='Stream completed'),
        ], streaming=True)
        self.assertEqual(result['reply'], 'Stream completed')
        self.assertTrue(all(payload['stream'] for payload in payloads))
        self.assertEqual([t['name'] for t in payloads[0]['tools']], ['discover_tools'])
        self.assertIn('get_session_summary', [t['name'] for t in payloads[1]['tools']])

    def test_discovery_only_does_not_block_fallback(self):
        result, _ = self.run_loop('gemini', [response(text='Fallback completed')], fail_claude=True)
        self.assertEqual(result['reply'], 'Fallback completed')
        self.assertEqual(result['trace']['providerFallback']['reason'], 'timeout')

    def test_discovery_loop_is_bounded_and_reports_exhaustion(self):
        for provider in ['claude', 'gemini']:
            with self.subTest(provider=provider):
                result, payloads = self.run_loop(provider, [response(call('discover_tools', {'names': ['get_session_summary']}))] * 6)
                self.assertEqual(len(payloads), 4)
                self.assertEqual(len(result['trace']['toolDiscovery']), 2)
                self.assertEqual(result['trace']['terminationReason'], 'round_limit')
                self.assertIn('limit', result['reply'])

    def test_ordinary_loop_is_bounded_after_successful_actions(self):
        for provider in ['claude', 'gemini']:
            with self.subTest(provider=provider):
                result, payloads = self.run_loop(provider, [response(call('log_set', {
                    'exercise_name': 'Barbell Back Squat', 'weight': 40, 'reps': 6}))] * 9,
                    active={'id': 'active', 'exercises': []})
                self.assertEqual(len(payloads), 7)
                self.assertEqual(len(result['actionsExecuted']), 6)
                self.assertIn('Completed actions', result['reply'])
                self.assertEqual(result['reply'].count('Satz geloggt'), 6)


    def test_repeat_adapt_with_dependent_lookups_reaches_preview_and_answer(self):
        # Reproduces the observed sequence using only synthetic inputs/results:
        # discovery -> session+resolution -> history+progression -> more history
        # -> remaining progression -> preview -> final response.
        rounds = [
            response(call('discover_tools', {'names': ['get_session_summary', 'resolve_exercise',
                'get_exercise_history', 'suggest_weight', 'start_workout_session']})),
            response(call('get_session_summary', {'limit': 1, 'include_details': True}, 'session'),
                     call('resolve_exercise', {'query': 'Barbell Overhead Press'}, 'resolve')),
            response(call('get_exercise_history', {'exercise_id': 'press'}, 'history'),
                     call('suggest_weight', {'exercise_id': 'squat'}, 'progression')),
            response(call('get_exercise_history', {'exercise_id': 'squat'})),
            response(call('suggest_weight', {'exercise_id': 'press'})),
            response(call('start_workout_session', {'title': 'Synthetic revised full body', 'exercises': [
                {'exerciseName': 'Barbell Back Squat', 'sets': [{'weight': 40, 'reps': 6, 'setType': 'working'}]}]})),
            response(text='Your workout preview is ready.'),
        ]
        for provider in ['claude', 'gemini']:
            with self.subTest(provider=provider):
                result, payloads = self.run_loop(provider, rounds, streaming=(provider == 'claude'))
                self.assertEqual(len(payloads), 7)
                self.assertEqual(result['actionExecuted']['type'], 'workout_proposed')
                self.assertEqual(result['reply'], 'Your workout preview is ready.')
                self.assertEqual(result['trace']['terminationReason'], 'completed')

    def test_exhaustion_reserves_an_answer_without_enabling_more_actions(self):
        rounds = [response(call('discover_tools', {'names': ['get_session_summary']}))]
        rounds += [response(call('get_session_summary', {'limit': 1}))] * 6
        rounds += [response(text='I checked the available history, but did not create a preview.')]
        for provider in ['claude', 'gemini']:
            with self.subTest(provider=provider):
                result, payloads = self.run_loop(provider, rounds)
                self.assertEqual(len(payloads), 8)
                self.assertIn('did not create a preview', result['reply'])
                self.assertEqual(result['trace']['terminationReason'], 'round_limit')
                self.assertEqual(result['actionsExecuted'], [])
                if provider == 'claude':
                    self.assertEqual(payloads[-1]['tool_choice'], {'type': 'none'})
                else:
                    self.assertEqual(payloads[-1]['toolConfig']['function_calling_config']['mode'], 'NONE')

    def test_empty_response_is_not_misreported_as_round_exhaustion(self):
        for provider in ['claude', 'gemini']:
            with self.subTest(provider=provider):
                result, payloads = self.run_loop(provider, [response(text='')])
                self.assertEqual(len(payloads), 1)
                self.assertEqual(result['trace']['terminationReason'], 'empty_response')
                self.assertIn('returned no answer', result['reply'])
                self.assertNotIn('processing limit', result['reply'])
