import json
import unittest
from unittest.mock import Mock, patch
from app.agent.coach import _try_enqueue_summary
from app.memory import summary, summary_jobs


class SummaryResilienceTests(unittest.TestCase):
    def test_failed_enqueue_preserves_chat_execution(self):
        session = Mock()
        with patch.object(summary_jobs, 'enqueue_if_needed', side_effect=RuntimeError('queue unavailable')):
            self.assertFalse(_try_enqueue_summary(session, 1, 'chat'))
        session.rollback.assert_called_once()

    def test_text_summary_does_not_require_embedding_provider(self):
        with patch.object(summary.settings, 'CLAUDE_API_KEY', 'test'), \
                patch.object(summary, 'generate_claude_text', return_value={
                    'text': json.dumps({'summary': 'Prefers morning training', 'description': 'Preference'}),
                    'usage': None,
                }), \
                patch('app.memory.store.embed', side_effect=AssertionError('Must not call Gemini')):
            result = summary.generate_summary('[USER] I prefer morning training')
        self.assertEqual(result['summary'], 'Prefers morning training')

    def test_malformed_output_is_retried_instead_of_archiving_raw_transcript(self):
        for output in ('bad JSON', '{}', '[]', '{"summary":[],"description":"Label"}'):
            with self.subTest(output=output), patch.object(summary.settings, 'CLAUDE_API_KEY', 'test'), \
                    patch.object(summary, 'generate_claude_text', return_value={'text':output,'usage':None}):
                with self.assertRaises(ValueError): summary.generate_summary('Original user facts')
