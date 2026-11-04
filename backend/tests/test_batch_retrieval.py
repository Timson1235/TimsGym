"""Synthetic batch contracts and real agent-loop integration on both providers."""
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from sqlmodel import SQLModel, Session, create_engine
from google.genai import types

from app import tracing
from app.agent.batch_retrieval import handle_batch_retrieve, BATCH_DECLARATION
from app.agent.tool_registry import REGISTRY, ToolSession
from app.agent.prompts import build_system_instruction
from tests import test_tool_discovery as discovery
from tests.test_tool_discovery import LIBRARY, workout, response, call


def query(key, tool, **arguments):
    return {'key': key, 'tool': tool, 'arguments': arguments}


class BatchRetrievalTests(unittest.TestCase):
    def setUp(self):
        self.db = {'profile': {}, 'exercises': deepcopy(LIBRARY), 'workouts': [
            workout('full', 'Full body', LIBRARY[0], '2026-10-20'),
            workout('press', 'Upper body', LIBRARY[1], '2026-10-22'),
        ]}

    def run_batch(self, requests):
        return handle_batch_retrieve(None, 7, self.db, {'requests': requests})['results']

    def test_batch_is_discoverable_read_only_and_supported_by_gemini_schema(self):
        session = ToolSession(False)
        with self.assertRaisesRegex(ValueError, 'inactive'):
            session.validate('batch_retrieve', {'requests': []})
        session.discover(['batch_retrieve'])
        declarations = session.declarations()
        self.assertTrue(session.validate('batch_retrieve', {'requests': [
            query('last', 'get_session_summary', limit=1),
        ]}).read_only)
        types.Tool(function_declarations=declarations)
        prompt = build_system_instruction({}, None)
        self.assertIn('batch_retrieve', prompt)
        self.assertIn('batch all needed progression checks', prompt)

    def test_mixed_lookup_keeps_canonical_ids_and_exact_reference(self):
        original = deepcopy(self.db)
        results = self.run_batch([
            query('reference', 'get_session_summary', search_title_or_date='full body', limit=1, include_details=True),
            query('press_last', 'get_exercise_history', exercise_name='Barbell Overhead Press', limit=1),
            query('resolve', 'resolve_exercise', query='Kniebeuge'),
            query('progress', 'suggest_weight', exercise_id='squat'),
            query('exact', 'get_workout_details', workout_id='press'),
        ])
        self.assertTrue(all(item['success'] for item in results))
        reference = results[0]['result']['sessions'][0]
        self.assertEqual(reference['id'], 'full')
        self.assertEqual(reference['workout'], self.db['workouts'][0])
        self.assertNotIn('exercises', reference)  # sets only appear in workout
        self.assertEqual(results[1]['result']['exerciseId'], 'press')
        self.assertEqual(results[1]['result']['history'][0]['workoutId'], 'press')
        self.assertEqual(results[2]['result']['id'], 'squat')
        self.assertEqual(results[3]['result']['status'], 'needs_setup')
        self.assertEqual(results[4]['result']['workout']['id'], 'press')
        self.assertEqual(self.db, original)

    def test_progression_for_multiple_exercises_in_one_call(self):
        results = self.run_batch([query(exercise['id'], 'suggest_weight', exercise_id=exercise['id']) for exercise in LIBRARY])
        self.assertEqual([item['key'] for item in results], ['squat', 'press'])
        self.assertTrue(all(item['result']['status'] == 'needs_setup' for item in results))

    def test_one_invalid_query_does_not_erase_other_results(self):
        results = self.run_batch([
            query('invalid', 'get_workout_details'),
            query('wrong_args', 'suggest_weight', workout_id='full'),
            query('missing', 'get_workout_details', workout_id='another-users-workout'),
            query('valid', 'get_exercise_history', exercise_id='squat', limit=1),
        ])
        self.assertFalse(results[0]['success'])
        self.assertIn('workout_id', results[0]['error'])
        self.assertFalse(results[1]['success'])
        self.assertEqual(results[2]['result']['status'], 'not_found')
        self.assertTrue(results[3]['success'])
        self.assertEqual(results[3]['result']['history'][0]['workoutId'], 'full')

    def test_ambiguous_and_missing_exercises_are_not_guessed(self):
        self.db['exercises'].append({'id': 'dbpress', 'name': 'Dumbbell Overhead Press', 'category': 'Shoulders'})
        results = self.run_batch([
            query('ambiguous', 'get_exercise_history', exercise_name='Overhead Press'),
            query('unknown', 'suggest_weight', exercise_name='Nonexistent synthetic exercise'),
            query('good', 'suggest_weight', exercise_id='squat'),
        ])
        self.assertEqual(results[0]['result']['status'], 'ambiguous')
        self.assertEqual(results[0]['result']['history'], [])
        self.assertEqual(results[1]['result']['status'], 'not_found')
        self.assertEqual(results[2]['result']['status'], 'needs_setup')

    def test_batch_cannot_mutate_or_recurse(self):
        with patch('app.agent.tools.crud.update_user_profile') as update:
            results = self.run_batch([
                query('write', 'save_personal_memory', memory='Do not save this'),
                query('recursive', 'batch_retrieve', requests=[]),
                query('discovery', 'discover_tools', names=['log_set']),
            ])
        self.assertTrue(all(not item['success'] for item in results))
        update.assert_not_called()
        self.assertEqual(self.db['profile'], {})

    def test_duplicate_lookups_execute_once_and_do_not_duplicate_output(self):
        from dataclasses import replace
        spec = REGISTRY['get_session_summary']
        calls = []
        def read(*args, **kwargs):
            calls.append(1)
            return spec.handler(*args, **kwargs)
        with patch.dict(REGISTRY, {'get_session_summary': replace(spec, handler=read)}):
            results = self.run_batch([
                query('first', 'get_session_summary', limit=1),
                query('again', 'get_session_summary', limit=1),
            ])
        self.assertEqual(len(calls), 1)
        self.assertEqual(results[1]['duplicateOf'], 'first')
        self.assertNotIn('result', results[1])

    def test_batch_bounds_keys_and_argument_types_are_validated(self):
        spec = REGISTRY['batch_retrieve']
        for args in [{'requests': []}, {'requests': [query(str(i), 'get_session_summary') for i in range(17)]},
                     {'requests': [query('bad', 'delete_workout', searchOrId='full')]},
                     {'requests': [query('bad', 'get_session_summary', limit='many')]}]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                spec.validate(args)
        for requests in [[query('same', 'get_session_summary'), query('same', 'get_session_summary')],
                         [query(' ', 'get_session_summary')]]:
            with self.assertRaisesRegex(ValueError, 'unique, nonempty'):
                self.run_batch(requests)

    def test_nested_spans_preserve_each_input_output_and_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = create_engine(f'sqlite:///{Path(directory) / "synthetic.db"}')
            SQLModel.metadata.create_all(engine)
            with tracing.request_trace(engine, 'batch-test', 7, 'synthetic'):
                with tracing.Span('tool', 'batch_retrieve') as outer:
                    self.run_batch([query('one', 'get_session_summary', limit=1), query('bad', 'get_workout_details')])
            with Session(engine) as session:
                trace = tracing.read_trace(session, 7, 'batch-test', True)
            children = [span for span in trace['spans'] if span['kind'] == 'retrieval']
            self.assertEqual(len(children), 2)
            self.assertTrue(all(span['parent_span_id'] == outer.id for span in children))
            self.assertEqual(children[0]['status'], 'completed')
            self.assertEqual(children[1]['status'], 'error')
            payload = trace['payloads'][children[0]['output_payload_id']]
            self.assertEqual(payload['key'], 'one')
            self.assertEqual(payload['result']['sessions'][0]['id'], 'press')
            engine.dispose()


class BatchWorkflowTests(unittest.TestCase):
    def run_loop(self, *args, **kwargs):
        return discovery.ProviderDiscoveryTests.run_loop(self, *args, **kwargs)

    def test_batch_repeat_adapt_and_progression_reach_preview_in_five_rounds(self):
        db = {'profile': {}, 'exercises': LIBRARY, 'workouts': [
            workout('full', 'Full body', LIBRARY[0], '2026-10-20'),
            workout('press', 'Upper body', LIBRARY[1], '2026-10-22')]}
        rounds = [
            response(call('discover_tools', {'names': ['batch_retrieve', 'start_workout_session']})),
            response(call('batch_retrieve', {'requests': [
                query('reference', 'get_session_summary', search_title_or_date='full body', limit=1, include_details=True),
                query('press_last', 'get_exercise_history', exercise_name='Barbell Overhead Press', limit=1),
            ]})),
            response(call('batch_retrieve', {'requests': [
                query('squat_next', 'suggest_weight', exercise_id='squat'),
                query('press_next', 'suggest_weight', exercise_id='press'),
            ]})),
            response(call('start_workout_session', {'title': 'Full body press focus', 'exercises': [
                {'exerciseName': 'Barbell Overhead Press', 'sets': [{'weight': 40, 'reps': 6, 'setType': 'working'}]}]})),
            response(text='Reference: 2026-10-20. Full plan: overhead press, 40 kg for 6 reps. Preview ready.'),
        ]
        for provider in ['claude', 'gemini']:
            with self.subTest(provider=provider):
                result, payloads = self.run_loop(provider, rounds, db=db, streaming=(provider == 'claude'))
                self.assertEqual(len(payloads), 5)
                self.assertEqual(result['toolsUsed'], ['discover_tools', 'batch_retrieve', 'batch_retrieve', 'start_workout_session'])
                self.assertEqual(result['actionExecuted']['type'], 'workout_proposed')
                self.assertEqual(result['trace']['terminationReason'], 'completed')
                self.assertIn('40 kg for 6 reps', result['reply'])
                self.assertNotIn('suggest_weight', [tool['name'] for tool in payloads[2]['tools']])
                self.assertIn('needs_setup', json.dumps(payloads[3]))
                self.assertIn('2026-10-20', json.dumps(payloads[2]))

    def test_batch_stays_read_only_for_provider_fallback(self):
        def failing_claude(**kwargs):
            kwargs['handle_tool']('discover_tools', {'names': ['batch_retrieve']}, 'discovery')
            kwargs['get_tools']()
            feedback = kwargs['handle_tool']('batch_retrieve', {'requests': [query('last', 'get_session_summary', limit=1)]}, 'batch')
            self.assertIn('sessions', feedback)
            raise TimeoutError('Synthetic timeout after batch read')
        from app.agent import coach
        with patch.object(coach, 'run_claude_agent', side_effect=failing_claude):
            result, _ = self.run_loop('claude', [response(text='Fallback after batch read')])
        self.assertEqual(result['trace']['providerFallback']['to'], 'gemini')
        self.assertEqual(result['reply'], 'Fallback after batch read')
