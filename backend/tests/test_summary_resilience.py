import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from app.agent.coach import _try_summarize
from app.memory import summary


class SummaryResilienceTests(unittest.TestCase):
    def test_failed_compaction_preserves_chat_execution(self):
        session = Mock()
        with patch.object(summary, 'summarize_conversation', side_effect=RuntimeError('provider unavailable')):
            self.assertIsNone(_try_summarize(session, 1, 'chat'))
        session.rollback.assert_called_once()

    def test_text_summary_does_not_require_embedding_provider(self):
        session = Mock()
        session.exec.return_value.all.return_value = [
            SimpleNamespace(role='user', content='A preference', summary_id=None) for _ in range(6)
        ]
        with patch.object(summary.flags, 'summary', True), \
                patch.object(summary.settings, 'CLAUDE_API_KEY', 'test'), \
                patch.object(summary, 'generate_claude_text', return_value={
                    'text': json.dumps({'summary': 'Prefers morning training', 'description': 'Preference'}),
                    'usage': None,
                }), \
                patch('app.memory.store.embed', side_effect=AssertionError('Must not call Gemini')):
            result = summary.summarize_conversation(session, 1, 'chat')
        self.assertEqual(result['summary'], 'Prefers morning training')
        self.assertIsNone(session.exec.call_args.kwargs['params']['emb'])
        session.commit.assert_called_once()
