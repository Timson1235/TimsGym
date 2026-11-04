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
        manager = ContextSelection(self.messages)
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
