import json
import unittest
from unittest.mock import patch

from app.agent.context_selection import ContextSelection
from app.agent.claude_provider import run_claude_agent
from app.agent.read_cache import RequestReadCache
from app.agent.tool_registry import REGISTRY


class ContextSelectionTests(unittest.TestCase):
    def setUp(self):
        self.messages = [{'role': 'user', 'content': 'old question'},
                         {'role': 'assistant', 'content': 'old answer'},
                         {'role': 'user', 'content': 'current request'}]
        self.exchange = [
            {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'read1',
                'name': 'get_workout_details', 'input': {'workout_id': 'w1'}}]},
            {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'read1',
                'content': 'exact sets ' * 3000}]}]

    def test_compaction_and_restore_preserve_archive_and_exchange_ids(self):
        manager = ContextSelection(self.messages, read_budget_chars=100000)
        manager.read_ids.add('read1')
        archive = self.messages + self.exchange
        manager.apply({'history': 'current', 'results': [
            {'call_id': 'read1', 'mode': 'summary', 'summary': 'Unselected workout w1.'}]})
        view = manager.view(archive)
        self.assertEqual(view[0]['content'], 'current request')
        self.assertEqual(view[-1]['content'][0]['tool_use_id'], 'read1')
        self.assertLess(len(json.dumps(view)), len(json.dumps(archive)) // 10)
        self.assertEqual(archive[-1]['content'][0]['content'], 'exact sets ' * 3000)
        manager.apply({'history': 'all', 'results': [{'call_id': 'read1', 'mode': 'full'}]})
        self.assertEqual(manager.view(archive), archive)

    def test_mutations_unknown_refs_and_empty_summaries_rejected(self):
        manager = ContextSelection(self.messages)
        for call_id, summary in [('read1', 'Cannot prune mutation'), ('unknown', 'Missing')]:
            with self.assertRaises(ValueError):
                manager.split({'_context': {'results': [
                    {'call_id': call_id, 'mode': 'summary', 'summary': summary}]}}, self.messages + self.exchange)
        manager.read_ids.add('read1')
        with self.assertRaises(ValueError):
            manager.split({'_context': {'results': [{'call_id': 'read1', 'mode': 'summary'}]}}, self.messages + self.exchange)

    def test_recent_history_is_bounded_and_current_request_retained(self):
        messages = [{'role': 'user', 'content': str(i)} for i in range(12)]
        manager = ContextSelection(messages)
        manager.apply({'history': 'recent'})
        self.assertEqual(manager.view(messages), messages[-5:])

    def test_raw_feedback_has_no_dangling_cross_result_references(self):
        cache = RequestReadCache(compact_feedback=False)
        value = {'workout': {'id': 'w1', 'sets': [{'weight': 60}]}}
        for _ in range(2):
            result = cache.feedback('get_workout_details', {'workout_id': 'w1'}, value, {})
            self.assertEqual(result, value)
            self.assertIsNot(result, value)

    def test_loop_selects_context_without_extra_model_call_and_restricts_schemas(self):
        responses = [
            {'content': [{'type': 'tool_use', 'id': 'read1', 'name': 'get_session_summary', 'input': {}}]},
            {'content': [{'type': 'tool_use', 'id': 'detail', 'name': 'get_workout_details',
                'input': {'workout_id': 'w1', '_context': {'history': 'current',
                    'results': [{'call_id': 'read1', 'mode': 'summary', 'summary': 'Selected w1.'}],
                    'tools': ['get_workout_details']}}}]},
            {'content': [{'type': 'text', 'text': 'Confirmed 60 kg.'}]}]
        tools = [REGISTRY[name].declaration for name in
                 ['discover_tools', 'get_session_summary', 'get_workout_details']]
        calls = []
        with patch('app.agent.claude_provider._request_json', side_effect=responses) as request:
            result = run_claude_agent(api_key='test', model='test', system_instruction='safety',
                messages=self.messages, tools=tools, context_selection=True,
                handle_tool=lambda name, args, cid: calls.append((name, args)) or
                    ('candidate data ' * 3000 if cid == 'read1' else 'w1: 3 working sets at 60 kg'))
        payloads = [json.loads(call.args[0].data) for call in request.call_args_list]
        self.assertEqual(len(payloads), 3)
        self.assertEqual(result['text'], 'Confirmed 60 kg.')
        self.assertEqual(calls[-1][1], {'workout_id': 'w1'})
        self.assertNotIn('candidate data', json.dumps(payloads[-1]))
        self.assertIn('3 working sets at 60 kg', json.dumps(payloads[-1]))
        self.assertEqual({t['name'] for t in payloads[-1]['tools']}, {'discover_tools', 'get_workout_details'})
        self.assertTrue(payloads[-1]['system'][0]['text'].startswith('safety'))

    def test_invalid_control_does_not_execute_mutation(self):
        calls = []
        with patch('app.agent.claude_provider._request_json', side_effect=[
            {'content': [{'type': 'tool_use', 'id': 'write', 'name': 'log_set',
                'input': {'_context': {'tools': ['not_a_tool']}}}]},
            {'content': [{'type': 'text', 'text': 'Nothing executed.'}]}]):
            run_claude_agent(api_key='test', model='test', system_instruction='safety',
                messages=self.messages, tools=[REGISTRY['log_set'].declaration],
                context_selection=True, handle_tool=lambda *args: calls.append(args))
        self.assertEqual(calls, [])

    def test_automatic_budget_applies_when_model_never_selects_context(self):
        manager = ContextSelection(self.messages, read_budget_chars=2000)
        archive = list(self.messages)
        for index in range(5):
            call_id = f'read{index}'
            manager.read_ids.add(call_id)
            archive += [
                {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': call_id,
                    'name': 'get_workout_details', 'input': {'workout_id': str(index)}}]},
                {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': call_id,
                    'content': f'Workout {index}: ' + 'Exact historical data. ' * 60}]}]
        view = manager.view(archive)
        self.assertLessEqual(manager.stats['readCharactersAfter'], 2000)
        self.assertGreater(manager.stats['compactedResults'], 0)
        self.assertEqual(view[-1], archive[-1])  # Fresh result remains exact.
        self.assertEqual(view[:3], self.messages)  # No automatic loss of user constraints.
        self.assertIn('compacted', view[4]['content'][0]['content'])
        self.assertNotIn('compacted', archive[4]['content'][0]['content'])

    def test_full_selection_prioritizes_restore_but_cannot_bypass_budget(self):
        manager = ContextSelection(self.messages, read_budget_chars=1500)
        manager.read_ids.add('read1')
        manager.apply({'results': [{'call_id': 'read1', 'mode': 'full'}]})
        view = manager.view(self.messages + self.exchange)
        self.assertLessEqual(manager.stats['readCharactersAfter'], 1500)
        self.assertTrue(json.loads(view[-1]['content'][0]['content'])['compacted'])
        small = [{'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'read1',
                   'content': 'Exact selected working sets: 60 kg x 6; RPE unknown.'}]}]
        self.assertEqual(manager.view(self.messages + small)[-1], small[0])

    def test_mutation_exchanges_are_never_automatically_compacted(self):
        manager = ContextSelection(self.messages, read_budget_chars=200)
        mutation = [
            {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'write',
                'name': 'start_workout_session', 'input': {'sets': 'exact plan ' * 1000}}]},
            {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'write',
                'content': 'Confirmed workout preview. Not started.'}]}]
        self.assertEqual(manager.view(self.messages + mutation), self.messages + mutation)

    def test_duplicate_evidence_points_to_latest_copy_without_reexecution(self):
        manager = ContextSelection(self.messages)
        manager.read_ids.update(['a', 'b'])
        results = [{'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': key, 'content': 'same exact evidence ' * 100}
            for key in ['a', 'b']]}]
        view = manager.view(self.messages + results)
        receipt = json.loads(view[-1]['content'][0]['content'])
        self.assertEqual(receipt['sameAsCallId'], 'b')
        self.assertEqual(view[-1]['content'][1], results[0]['content'][1])

    def test_eight_round_regression_reduces_payload_even_without_context_controls(self):
        def call(name, key):
            return {'content': [{'type': 'tool_use', 'name': name, 'id': key, 'input': {}}]}
        responses = [call('discover_tools', 'discovery')]
        responses += [call('batch_retrieve', f'batch{i}') for i in range(5)]
        responses += [call('start_workout_session', 'write'),
                      {'content': [{'type': 'text', 'text': 'Preview ready, not started.'}]}]
        declarations = [REGISTRY[name].declaration for name in
                        ['discover_tools', 'batch_retrieve', 'start_workout_session']]
        payloads = {}
        for enabled in [False, True]:
            calls = []
            with patch('app.agent.claude_provider._request_json', side_effect=responses) as request:
                run_claude_agent(api_key='test', model='test', system_instruction='Do not ignore knee pain.',
                    messages=self.messages, tools=declarations, context_selection=enabled,
                    handle_tool=lambda name, args, key: calls.append((name, key)) or (
                        f'{key}: ' + 'Recorded sets and notes. ' * 250 if name == 'batch_retrieve'
                        else 'Confirmed preview, not started.'))
            payloads[enabled] = [json.loads(call.args[0].data) for call in request.call_args_list]
            self.assertEqual(len(calls), 7)
            self.assertEqual(len(payloads[enabled]), 8)
            self.assertIn('Confirmed preview, not started.', json.dumps(payloads[enabled][-1]))
        before = sum(len(json.dumps(p)) for p in payloads[False])
        after = sum(len(json.dumps(p)) for p in payloads[True])
        self.assertLess(after, before * 0.8)
        self.assertNotIn('tools', payloads[True][-1])
