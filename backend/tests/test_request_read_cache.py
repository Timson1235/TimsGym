import json
import unittest
from copy import deepcopy
from dataclasses import replace
from unittest.mock import Mock, patch

from app.agent.read_cache import RequestReadCache
from app.agent.tool_registry import REGISTRY
from tests import test_tool_discovery as workflow
from tests.test_training_retrieval import LIBRARY, workout
from app.agent import tools


class RequestReadCacheTests(unittest.TestCase):
    def setUp(self):
        self.db = {'exercises': deepcopy(LIBRARY), 'workouts': [workout('one', '2026-10-20', 'Full body', 'squat')]}
        self.cache = RequestReadCache()

    def test_alias_id_defaults_and_limit_clamping_share_cache_but_distinct_limits_do_not(self):
        load = Mock(return_value={'history': []})
        for args in [{'exercise_name': 'Kniebeuge'}, {'exercise_id': 'squat', 'limit': 5}]:
            self.cache.read('get_exercise_history', args, self.db, load)
        self.assertEqual(load.call_count, 1)
        self.cache.read('get_exercise_history', {'exercise_id':'squat', 'limit':1}, self.db, load)
        self.assertEqual(load.call_count, 2)
        a = self.cache.key('get_session_summary', {}, self.db)
        b = self.cache.key('get_session_summary', {'limit':3, 'include_details':False, 'search_title_or_date':'  '}, self.db)
        self.assertEqual(a, b)
        self.assertNotEqual(a, self.cache.key('get_session_summary', {'include_details':True}, self.db))
        self.assertNotEqual(a, self.cache.key('get_session_summary', {'cursor':'opaque'}, self.db))

    def test_returned_values_are_snapshots_and_failed_reads_are_not_cached(self):
        value = {'history': [{'sets': [1]}]}
        load = Mock(return_value=value)
        first = self.cache.read('suggest_weight', {'exercise_id':'squat'}, self.db, load)
        first['history'].clear()
        value['history'].clear()
        self.assertEqual(self.cache.read('suggest_weight', {'exercise_id':'squat'}, self.db, load)['history'], [{'sets':[1]}])
        fail = Mock(side_effect=ValueError('broken'))
        for _ in range(2):
            with self.assertRaises(ValueError):
                self.cache.read('get_workout_details', {'workout_id':'bad'}, self.db, fail)
        self.assertEqual(fail.call_count, 2)

    def test_repeated_feedback_is_a_short_reference_and_invalidation_requires_fresh_data(self):
        args = {'exercise_id':'squat'}
        value = {'evidence':['x'*3000], 'status':'hold'}
        first = self.cache.feedback('suggest_weight', args, value, self.db)
        second = self.cache.feedback('suggest_weight', args, value, self.db)
        self.assertTrue(second['reused'])
        self.assertEqual(first['resultRef'], second['resultRef'])
        self.assertLess(len(json.dumps(second)), len(json.dumps(first)))
        self.cache.invalidate()
        third = self.cache.feedback('suggest_weight', args, value, self.db)
        self.assertNotIn('reused', third)
        self.assertNotEqual(first['resultRef'], third['resultRef'])

    def test_full_session_seeds_details_and_overlapping_history_uses_outcome_projection(self):
        self.db['workouts'][0]['exercises'][0]['sets'] *= 6
        value = tools.handle_get_session_summary(None, 1, self.db, {'include_details':True})
        first = self.cache.feedback('get_session_summary', {'include_details':True}, value, self.db)
        load = Mock(side_effect=AssertionError('must not execute duplicate detail read'))
        details = self.cache.read('get_workout_details', {'workout_id':'one'}, self.db, load)
        self.assertEqual(details['workout'], self.db['workouts'][0])
        projected = self.cache.feedback('get_workout_details', {'workout_id':'one'}, details, self.db)
        self.assertIn('dataRef', projected['workout'])
        history = tools.handle_get_exercise_history(None, 1, self.db, {'exercise_id':'squat'})
        before = deepcopy(history)
        projected = self.cache.feedback('get_exercise_history', {'exercise_id':'squat'}, history, self.db)
        self.assertEqual(projected['history'][0]['sets']['returnedSetCount'], 12)
        self.assertIn('Completed outcome', projected['history'][0]['sets']['projection'])
        self.assertEqual(history, before)
        # Different/more recent evidence must never be silently replaced.
        history['history'][0]['sets'][0]['weight'] = 999
        other = self.cache.feedback('get_exercise_history', {'exercise_id':'squat', 'limit':1}, history, self.db)
        self.assertIsInstance(other['history'][0]['sets'], list)

    def test_new_request_does_not_reuse_old_references(self):
        args = {'exercise_id':'squat'}
        self.cache.feedback('suggest_weight', args, {'status':'hold'}, self.db)
        fresh = RequestReadCache().feedback('suggest_weight', args, {'status':'hold'}, self.db)
        self.assertNotIn('reused', fresh)

    def test_write_tools_cannot_enter_read_cache(self):
        load = Mock()
        with self.assertRaises(ValueError):
            self.cache.read('log_set', {}, self.db, load)
        load.assert_not_called()

    def test_small_overlaps_remain_inline_when_reference_would_be_larger(self):
        self.cache.feedback('get_session_summary', {'include_details':True},
                            tools.handle_get_session_summary(None, 1, self.db, {'include_details':True}), self.db)
        history = tools.handle_get_exercise_history(None, 1, self.db, {'exercise_id':'squat'})
        projected = self.cache.feedback('get_exercise_history', {'exercise_id':'squat'}, history, self.db)
        self.assertEqual(projected['history'][0]['sets'], history['history'][0]['sets'])


class RequestCacheWorkflowTests(unittest.TestCase):
    def last_feedback(self, provider, payload):
        if provider == 'claude':
            return json.loads(payload['messages'][-1]['content'][0]['content'])
        return json.loads(payload['contents'][-1]['parts'][0]['function_response']['response']['result'])

    def run_loop(self, *args, **kwargs):
        return workflow.ProviderDiscoveryTests.run_loop(self, *args, **kwargs)

    def test_direct_and_batch_reads_share_results_on_both_providers(self):
        for provider in ['claude', 'gemini']:
            with self.subTest(provider=provider):
                spec = REGISTRY['get_exercise_history']
                handler = Mock(wraps=spec.handler)
                rounds = [
                    workflow.response(workflow.call('discover_tools', {'names':['batch_retrieve','get_exercise_history']})),
                    workflow.response(workflow.call('batch_retrieve', {'requests':[{'key':'first','tool':'get_exercise_history','arguments':{'exercise_name':'Kniebeuge'}}]})),
                    workflow.response(workflow.call('get_exercise_history', {'exercise_id':'squat','limit':5})),
                    workflow.response(workflow.call('batch_retrieve', {'requests':[{'key':'again','tool':'get_exercise_history','arguments':{'exercise_id':'squat'}}]})),
                    workflow.response(text='Done'),
                ]
                with patch.dict(REGISTRY, {'get_exercise_history':replace(spec,handler=handler)}):
                    result, payloads = self.run_loop(provider, rounds)
                self.assertEqual(handler.call_count, 1)
                self.assertEqual(result['trace']['readCache']['hits'], 2)
                self.assertTrue(self.last_feedback(provider, payloads[3])['reused'])

    def test_identical_writes_are_not_deduplicated_and_invalidate_reads(self):
        for provider in ['claude','gemini']:
            with self.subTest(provider=provider):
                spec = REGISTRY['suggest_weight']
                handler = Mock(wraps=spec.handler)
                args = {'exercise_name':'Barbell Back Squat','weight':40,'reps':6}
                rounds = [
                    workflow.response(workflow.call('discover_tools', {'names':['suggest_weight']})),
                    workflow.response(workflow.call('suggest_weight', {'exercise_id':'squat'})),
                    workflow.response(workflow.call('log_set', args, 'set1'),workflow.call('log_set', args, 'set2')),
                    workflow.response(workflow.call('suggest_weight', {'exercise_id':'squat'})),
                    workflow.response(text='Done'),
                ]
                with patch.dict(REGISTRY, {'suggest_weight':replace(spec,handler=handler)}):
                    result, payloads = self.run_loop(provider, rounds, active={'id':'active','exercises':[]})
                self.assertEqual(handler.call_count, 2)
                self.assertEqual(len(result['actionsExecuted']), 2)
                self.assertEqual(result['trace']['readCache']['generation'], 2)
                feedback = self.last_feedback(provider, payloads[-1])
                self.assertNotIn('reused', feedback)
                self.assertTrue(feedback['resultRef'].startswith('read-2-'))

    def test_provider_fallback_does_not_reference_claudes_unseen_results(self):
        from app.agent import coach

        def failed(**kwargs):
            kwargs['handle_tool']('discover_tools', {'names':['get_exercise_history']}, 'discovery')
            kwargs['handle_tool']('get_exercise_history', {'exercise_id':'squat'}, 'read')
            raise TimeoutError('Synthetic failure after a read')

        rounds = [
            workflow.response(workflow.call('get_exercise_history', {'exercise_id':'squat'})),
            workflow.response(text='Done'),
        ]
        with patch.object(coach, 'run_claude_agent', side_effect=failed):
            result, payloads = self.run_loop('claude', rounds)
        feedback = self.last_feedback('gemini', payloads[-1])
        self.assertNotIn('reused', feedback)
        self.assertIn('history', feedback)
        self.assertEqual(result['trace']['readCache']['generation'], 1)
