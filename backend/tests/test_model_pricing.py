import unittest
from app.agent.pricing import estimate_claude_cost

class PricingTests(unittest.TestCase):
    def test_haiku_threshold_counts_cached_input_per_request(self):
        low={'input_tokens':1000,'cache_read_input_tokens':99000,'output_tokens':1000}
        high={**low,'input_tokens':1001}
        self.assertAlmostEqual(estimate_claude_cost('claude-haiku-5-5',low),.00159)
        self.assertAlmostEqual(estimate_claude_cost('claude-haiku-5-5',high),.0079505)
    def test_sonnet_trace_and_unknown_model(self):
        self.assertAlmostEqual(estimate_claude_cost('claude-sonnet-5-5',{'input_tokens':52551,'cache_creation_input_tokens':11152,'cache_read_input_tokens':29035,'output_tokens':5319}),.1890755)
        self.assertIsNone(estimate_claude_cost('unknown',{}))
