import json
import unittest
from unittest.mock import patch, Mock
from app.agent.claude_provider import run_claude_agent, _request_stream, _system_blocks
from app.agent.coach import _build_system_instruction
from app.streaming import stream_events
from app.agent.tools import TOOL_DECLARATIONS
from app.agent.coach import _generate_with_retry
from google.genai import types


def event(kind, **fields):
    return {'type': kind, **fields}


class StreamResponse:
    def __init__(self, events):
        self.lines = ''.join('data: ' + json.dumps(e) + '\n\n' for e in events).encode().splitlines(keepends=True)
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def __iter__(self): return iter(self.lines)


def text_events(text):
    return [event('message_start', message={'usage': {'input_tokens': 10, 'cache_read_input_tokens': 4000}}),
            event('content_block_start', index=0, content_block={'type': 'text', 'text': ''}),
            event('content_block_delta', index=0, delta={'type': 'text_delta', 'text': text}),
            event('content_block_stop', index=0),
            event('message_delta', delta={'stop_reason': 'end_turn'}, usage={'output_tokens': 3}),
            event('message_stop')]


class ProviderStreamingTests(unittest.TestCase):
    def test_text_is_emitted_and_usage_and_final_reply_are_preserved(self):
        emitted = []
        with patch('app.agent.claude_provider.urlopen', return_value=StreamResponse(text_events('Hallo!'))) as opened:
            result = run_claude_agent(api_key='test', model='test', system_instruction='Rules\n=== USER DATA ===\nTest',
                                      messages=[{'role':'user','content':'Hi'}], tools=[], handle_tool=Mock(), on_event=emitted.append)
        self.assertIn({'type':'delta','text':'Hallo!'}, emitted)
        self.assertEqual(result['text'], 'Hallo!')
        self.assertEqual(result['usage']['outputTokens'], 3)
        self.assertEqual(result['usage']['cacheReadTokens'], 4000)
        self.assertTrue(json.loads(opened.call_args.args[0].data)['stream'])

    def test_fragmented_tool_arguments_execute_once_only_after_message_stop(self):
        sequence = [
            event('message_start', message={'usage': {}}),
            event('content_block_start', index=0, content_block={'type':'tool_use','id':'call','name':'log_set','input':{}}),
            event('content_block_delta', index=0, delta={'type':'input_json_delta','partial_json':'{"weight":'}),
            event('content_block_delta', index=0, delta={'type':'input_json_delta','partial_json':'40}'}),
            event('content_block_stop', index=0),
            event('message_delta', delta={'stop_reason':'tool_use'}), event('message_stop'),
        ]
        handler = Mock(return_value='Saved')
        with patch('app.agent.claude_provider.urlopen', side_effect=[StreamResponse(sequence), StreamResponse(text_events('Saved'))]):
            result = run_claude_agent(api_key='test', model='test', system_instruction='Rules',
                                      messages=[], tools=TOOL_DECLARATIONS, handle_tool=handler, on_event=lambda e: None)
        handler.assert_called_once_with('log_set', {'weight':40}, 'call')
        self.assertEqual(result['text'], 'Saved')

    def test_interrupted_and_truncated_streams_never_execute_tools(self):
        for ending in [[], [event('message_delta', delta={'stop_reason':'max_tokens'}), event('message_stop')]]:
            handler = Mock()
            data = [event('content_block_start', index=0, content_block={'type':'tool_use','id':'call','name':'log_set','input':{}}),
                    event('content_block_delta', index=0, delta={'type':'input_json_delta','partial_json':'{"weight":'})] + ending
            with patch('app.agent.claude_provider.urlopen', return_value=StreamResponse(data)):
                with self.assertRaises((RuntimeError, ValueError)):
                    run_claude_agent(api_key='test', model='test', system_instruction='Rules', messages=[],
                                     tools=TOOL_DECLARATIONS, handle_tool=handler, on_event=lambda e: None)
            handler.assert_not_called()

    def test_stable_cache_prefix_does_not_contain_user_specific_context(self):
        first = _build_system_instruction({'profile': {'name':'Alice'},'workouts':[],'exercises':[]}, None)
        second = _build_system_instruction({'profile': {'name':'Bob'},'workouts':[],'exercises':[]}, None)
        a,b = _system_blocks(first, True), _system_blocks(second, True)
        self.assertEqual(a[0], b[0])
        self.assertIn('cache_control', a[0])
        self.assertNotIn('cache_control', a[1])
        self.assertIn('Alice', a[1]['text'])
        self.assertNotEqual(a[1], b[1])
        self.assertNotIn('cache_control', _system_blocks(first, False)[0])

    def test_timeout_is_visible_in_model_trace(self):
        trace = []
        with patch('app.agent.claude_provider._request_stream', side_effect=TimeoutError('timed out')):
            with self.assertRaises(TimeoutError):
                run_claude_agent(api_key='test', model='test', system_instruction='Rules', messages=[],
                                 tools=[], handle_tool=Mock(), on_event=lambda e: None, on_trace_step=trace.append)
        self.assertEqual(trace[0]['status'], 'error')
        self.assertEqual(trace[0]['errorType'], 'TimeoutError')

    def test_provider_error_event_is_not_returned_as_success(self):
        with patch('app.agent.claude_provider.urlopen', return_value=StreamResponse([event('error', error={'type':'overloaded_error'})])):
            with self.assertRaisesRegex(RuntimeError, 'overloaded_error'):
                _request_stream(Mock(), timeout_seconds=1, on_text=Mock())


class SSEBridgeTests(unittest.TestCase):
    def test_emits_progress_then_final_result_once(self):
        def work(emit):
            emit({'type':'delta','text':'Hi'})
            return {'reply':'Hi','actionsExecuted':[]}
        events = [json.loads(frame[6:]) for frame in stream_events(work)]
        self.assertEqual([e['type'] for e in events], ['delta','final'])
        self.assertEqual(events[-1]['result']['reply'], 'Hi')

    def test_failure_has_terminal_error_without_exception_details(self):
        def work(emit): raise RuntimeError('secret provider details')
        events = list(stream_events(work))
        self.assertIn('"type":"error"', events[0])
        self.assertNotIn('secret', events[0])


class GeminiStreamingTests(unittest.TestCase):
    def test_stream_reassembles_text_tools_and_cached_usage_without_exposing_thoughts(self):
        client = Mock()
        client.models.generate_content_stream.return_value = [
            types.GenerateContentResponse(candidates=[types.Candidate(content=types.Content(role="model", parts=[
                types.Part(text="Private reasoning", thought=True), types.Part(text="Hello "),
            ]))]),
            types.GenerateContentResponse(model_version="test-gemini", candidates=[types.Candidate(
                finish_reason="STOP", content=types.Content(role="model", parts=[
                    types.Part(text="athlete"), types.Part(function_call=types.FunctionCall(name="get_session_summary", args={"limit":1})),
                ]))], usage_metadata=types.GenerateContentResponseUsageMetadata(prompt_token_count=10, cached_content_token_count=5)),
        ]
        events = []
        result = _generate_with_retry(client, "test-gemini", [], None, events.append)
        self.assertEqual([e['text'] for e in events if e['type']=='delta'], ["Hello ", "athlete"])
        self.assertEqual(result.function_calls[0].name, "get_session_summary")
        self.assertEqual(result.usage_metadata.cached_content_token_count,5)

    def test_incomplete_stream_is_not_accepted_as_completed_answer(self):
        client=Mock()
        client.models.generate_content_stream.return_value=[types.GenerateContentResponse(candidates=[types.Candidate(
            content=types.Content(role="model", parts=[types.Part(text="Partial")]))])]
        with self.assertRaisesRegex(RuntimeError,'finish reason'):
            _generate_with_retry(client, "test", [], None, lambda e: None)
