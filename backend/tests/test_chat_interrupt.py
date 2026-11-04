import unittest
from contextlib import ExitStack
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock, patch

from google.genai import types
from app.agent import coach
from app.chat_control import ChatInterrupted


class ChatInterruptTests(unittest.TestCase):
    def run_chat(self, provider, stopped, *, after_tool=None, transport=None):
        active = {'id': 'active', 'exercises': []}
        database = {'profile': {}, 'exercises': [{'id': 'squat', 'name': 'Squat', 'category': 'Legs'}], 'workouts': []}
        with ExitStack() as stack:
            stack.enter_context(patch.object(coach.settings, 'CLAUDE_API_KEY', 'test' if provider == 'claude' else ''))
            stack.enter_context(patch.object(coach, '_client', object()))
            stack.enter_context(patch.object(coach.crud, 'get_user_database_state', return_value=database))
            stack.enter_context(patch.object(coach.summ, 'read_coach_context', return_value=([], '')))
            writes = stack.enter_context(patch.object(coach.memory, 'write_message'))
            stack.enter_context(patch.object(coach.memory, 'write_tool_log', side_effect=after_tool))
            stack.enter_context(patch.object(coach.summary_jobs, 'enqueue_if_needed', return_value=False))
            claude = stack.enter_context(patch('app.agent.claude_provider._request_stream', side_effect=transport))
            gemini = stack.enter_context(patch.object(coach, '_generate_with_retry', side_effect=transport))
            result = coach.run_chat(None, SimpleNamespace(id=1), 'Log my sets', active,
                on_event=lambda event: None, is_cancelled=stopped.is_set)
        return result, claude, gemini, writes

    def test_interrupt_before_generation_never_calls_either_provider(self):
        for provider in ('claude', 'gemini'):
            stopped = Event()
            stopped.set()
            result, claude, gemini, writes = self.run_chat(provider, stopped)
            self.assertEqual(result['status'], 'interrupted')
            self.assertTrue(result['retrySafe'])
            claude.assert_not_called()
            gemini.assert_not_called()
            self.assertEqual(writes.call_count, 2)

    def test_interrupt_between_tools_keeps_first_set_without_replay(self):
        for provider in ('claude', 'gemini'):
            with self.subTest(provider=provider):
                stopped = Event()
                args = {'exercise_name': 'Squat', 'weight': 40, 'reps': 6}
                def transport(*args_, **kwargs):
                    if provider == 'claude':
                        return {'content': [{'type': 'tool_use', 'id': f'call-{i}', 'name': 'log_set', 'input': args} for i in range(2)], 'stop_reason': 'tool_use'}
                    return types.GenerateContentResponse(candidates=[types.Candidate(content=types.Content(role='model', parts=[
                        types.Part.from_function_call(name='log_set', args=args) for _ in range(2)]))])
                result, claude, gemini, _ = self.run_chat(provider, stopped, transport=transport,
                    after_tool=lambda *args: stopped.set())
                self.assertEqual(result['status'], 'interrupted')
                self.assertFalse(result['retrySafe'])
                self.assertEqual(len(result['actionsExecuted']), 1)
                self.assertEqual(len(result['activeWorkoutState']['exercises'][0]['sets']), 1)
                self.assertIn('Completed actions', result['reply'])
                self.assertEqual(result['trace']['terminationReason'], 'interrupted')
                if provider == 'claude':
                    claude.assert_called_once()
                    gemini.assert_not_called()
                else:
                    gemini.assert_called_once()

    def test_interrupt_streaming_is_not_a_provider_fallback(self):
        stopped = Event()
        def transport(*args, **kwargs):
            stopped.set()
            kwargs['on_text']('Unconfirmed text')
        result, claude, gemini, _ = self.run_chat('claude', stopped, transport=transport)
        self.assertEqual(result['status'], 'interrupted')
        self.assertTrue(result['retrySafe'])
        gemini.assert_not_called()

    def test_gemini_retry_does_not_swallow_interruption(self):
        client = Mock()
        client.models.generate_content_stream.side_effect = ChatInterrupted()
        with self.assertRaises(ChatInterrupted):
            coach._generate_with_retry(client, 'test', [], None, on_event=lambda event: None)
        client.models.generate_content_stream.assert_called_once()
