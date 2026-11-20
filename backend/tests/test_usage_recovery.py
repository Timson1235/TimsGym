import unittest
from unittest.mock import Mock, patch
from urllib.request import Request
from pydantic import ValidationError
from app.agent.usage import UsageLedger
from app.agent.progression import ProgressionConfig
from app.agent.claude_provider import IncompleteStream, _request_stream, run_claude_agent
from test_streaming import StreamResponse, text_events


class UsageRecoveryTests(unittest.TestCase):
    def test_free_fallback_preserves_claude_cost_and_thinking(self):
        ledger = UsageLedger('free')
        ledger.add('claude', 'claude-haiku-5-5', {'input_tokens': 1000, 'output_tokens': 100})
        ledger.add('gemini', 'gemini-3.8-flash', {'prompt_token_count': 1000,
            'cached_content_token_count': 500, 'candidates_token_count': 100, 'thoughts_token_count': 200})
        result = ledger.summary()
        self.assertEqual(result['provider'], 'mixed')
        self.assertEqual(result['totalTokens'], 2400)
        self.assertEqual(result['thinkingTokens'], 200)
        self.assertGreater(result['estimatedCostUsd'], 0)

    def test_unknown_billing_and_partial_usage_are_not_zero(self):
        ledger = UsageLedger()
        ledger.add('gemini', 'gemini-3.8-flash', {'prompt_token_count': 100})
        self.assertIsNone(ledger.summary()['estimatedCostUsd'])
        ledger.add('claude', 'claude-haiku-5-5', {'input_tokens': 100}, False)
        self.assertFalse(ledger.summary()['usageComplete'])
        self.assertEqual(ledger.summary()['totalTokens'], 200)

    def test_eof_flushes_complete_final_event(self):
        response = StreamResponse(text_events('Hello'))
        response.lines = response.lines[:-1]
        with patch('app.agent.claude_provider.urlopen', return_value=response):
            result = _request_stream(Request('https://example.com'), timeout_seconds=1, on_text=lambda _: None)
        self.assertEqual(result['content'][0]['text'], 'Hello')

    def test_incomplete_generation_recovers_once_and_accounts_both_attempts(self):
        ledger = UsageLedger()
        handler = Mock()
        error = IncompleteStream('EOF', {'input_tokens': 12}, {'eventCounts': {}})
        with patch('app.agent.claude_provider._request_stream', side_effect=error), patch(
            'app.agent.claude_provider._request_json', return_value={
                'content': [{'type': 'text', 'text': 'Recovered'}], 'stop_reason': 'end_turn',
                'usage': {'input_tokens': 20, 'output_tokens': 2}}) as recovery:
            result = run_claude_agent(api_key='test', model='claude-haiku-5-5',
                system_instruction='Rules', messages=[], tools=[], handle_tool=handler,
                on_event=lambda _: None, on_usage=lambda raw, complete: ledger.add('claude', 'claude-haiku-5-5', raw, complete))
        self.assertEqual(result['text'], 'Recovered')
        recovery.assert_called_once()
        handler.assert_not_called()
        self.assertEqual(ledger.summary()['totalTokens'], 34)
        self.assertIsNone(ledger.summary()['estimatedCostUsd'])

    def test_bodyweight_increment_is_omitted_not_zero(self):
        args = dict(repMin=4, repMax=8, targetRir=2)
        self.assertIsNone(ProgressionConfig(**args).weightIncrement)
        with self.assertRaises(ValidationError):
            ProgressionConfig(**args, weightIncrement=0)

    def test_no_stream_retry_after_mutation(self):
        from app.agent.tools import TOOL_DECLARATIONS
        first = {'content': [{'type': 'tool_use', 'id': 'one', 'name': 'log_set', 'input': {'weight': 40}}],
                 'usage': {'input_tokens': 10}, 'stop_reason': 'tool_use'}
        handler = Mock(return_value='Saved')
        with patch('app.agent.claude_provider._request_stream', side_effect=[first, IncompleteStream('EOF', {}, {})]), patch(
            'app.agent.claude_provider._request_json') as recovery:
            with self.assertRaises(IncompleteStream):
                run_claude_agent(api_key='test', model='test', system_instruction='Rules', messages=[],
                    tools=TOOL_DECLARATIONS, handle_tool=handler, on_event=lambda _: None)
        handler.assert_called_once()
        recovery.assert_not_called()
