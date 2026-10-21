import unittest
from unittest.mock import Mock

from app.agent.coach import _generate_with_retry


class ProviderRetryTests(unittest.TestCase):
    def test_billing_failure_is_not_hidden_by_model_fallback(self):
        client = Mock()
        client.models.generate_content.side_effect = RuntimeError('402 RESOURCE_EXHAUSTED: Your prepayment credits are exhausted')
        with self.assertRaisesRegex(RuntimeError, 'prepayment'):
            _generate_with_retry(client, 'primary', [], None)
        self.assertEqual(client.models.generate_content.call_count, 1)
