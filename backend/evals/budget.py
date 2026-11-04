"""Eval-only preflight reservation and usage accounting; not a billing guarantee."""
from dataclasses import dataclass, asdict
from math import ceil, isfinite
import time

PRICING_DATE = '2026-10-23'
PRICING_SOURCE = 'https://claude.com/pricing'
# Standard global API, five-minute cache writes. Unknown models fail closed.
PRICES = {
    'claude-sonnet-5-5': {'input_tokens': 2.0, 'output_tokens': 10.0,
                        'cache_creation_input_tokens': 2.5, 'cache_read_input_tokens': 0.10},
    'claude-haiku-5-5': {'input_tokens': 0.10, 'output_tokens': 0.50,
                       'cache_creation_input_tokens': 0.125, 'cache_read_input_tokens': 0.01},
}


class EvaluationStopped(RuntimeError):
    pass


@dataclass
class Limits:
    total_usd: float = 0.25
    case_usd: float = 0.18
    max_calls: int = 12
    case_calls: int = 6
    max_input_tokens: int = 12000
    max_output_tokens: int = 1024
    total_seconds: float = 180
    case_seconds: float = 90

    def __post_init__(self):
        for name in ('total_usd', 'case_usd'):
            value = getattr(self, name)
            if not isfinite(value) or not 0 < value <= 1:
                raise ValueError(f'{name} must be positive and at most $1 for this small suite.')
        for name in ('max_calls', 'case_calls', 'max_input_tokens', 'max_output_tokens', 'total_seconds', 'case_seconds'):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or value <= 0:
                raise ValueError(f'{name} must be positive and finite.')
        if self.max_input_tokens > 12000 or self.max_output_tokens > 1024:
            raise ValueError('Small evals are capped at 12,000 input and 1,024 output tokens per request.')


class Budget:
    def __init__(self, model, limits=None, clock=time.perf_counter):
        if model not in PRICES:
            raise ValueError(f'No verified evaluation price for {model}. Supported: {", ".join(PRICES)}')
        self.model, self.limits, self.clock = model, limits or Limits(), clock
        self.rates = PRICES[model]
        self.started = clock()
        self.rounds = []
        self.stop_reason = None
        self.begin_case('initial')

    def begin_case(self, name):
        self.case = name
        self.case_started = self.clock()

    @property
    def charged(self):
        # Unknown usage retains its entire reservation; never report it as free.
        return sum(row['budgetChargeUsd'] for row in self.rounds)

    def stop(self, reason):
        self.stop_reason = reason
        raise EvaluationStopped(reason)

    def check_time(self):
        if self.clock() - self.started >= self.limits.total_seconds:
            self.stop('run_time_limit')
        if self.clock() - self.case_started >= self.limits.case_seconds:
            self.stop('case_time_limit')

    def reserve(self, input_tokens):
        self.check_time()
        if isinstance(input_tokens, bool) or not isinstance(input_tokens, int) or input_tokens < 0:
            self.stop('invalid_token_preflight')
        padded = ceil(input_tokens * 1.10) + 64
        if padded > self.limits.max_input_tokens:
            self.stop('input_token_limit')
        # Assume the most expensive input category, ignoring any cache savings.
        reservation = (padded * max(self.rates[k] for k in self.rates if k != 'output_tokens')
                       + self.limits.max_output_tokens * self.rates['output_tokens']) / 1_000_000
        case_rows = [row for row in self.rounds if row['case'] == self.case]
        if len(self.rounds) >= self.limits.max_calls:
            self.stop('run_call_limit')
        if len(case_rows) >= self.limits.case_calls:
            self.stop('case_call_limit')
        if self.charged + reservation > self.limits.total_usd:
            self.stop('run_cost_limit')
        if sum(row['budgetChargeUsd'] for row in case_rows) + reservation > self.limits.case_usd:
            self.stop('case_cost_limit')
        row = {'case': self.case, 'countedInputTokens': input_tokens, 'reservedUsd': reservation,
               'budgetChargeUsd': reservation, 'estimatedCostUsd': None, 'usage': None,
               'usageKnown': False, 'preflightMs': None, 'inferenceMs': None, 'errorType': None}
        self.rounds.append(row)
        return row

    def settle(self, row, usage):
        if not isinstance(usage, dict) or any(k not in usage for k in ('input_tokens', 'output_tokens')):
            self.stop('missing_provider_usage')
        counts = {}
        for key in self.rates:
            value = usage.get(key, 0)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                self.stop('invalid_provider_usage')
            counts[key] = value
        cost = sum(counts[key] * price for key, price in self.rates.items()) / 1_000_000
        row.update(usage=counts, estimatedCostUsd=cost, usageKnown=True, budgetChargeUsd=cost)
        if cost > row['reservedUsd']:
            self.stop('usage_exceeded_preflight_reservation')

    def snapshot(self):
        return {'model': self.model, 'limits': asdict(self.limits), 'pricingDate': PRICING_DATE,
                'pricingSource': PRICING_SOURCE, 'ratesPerMillionTokensUsd': self.rates,
                'estimatedKnownCostUsd': sum(row['estimatedCostUsd'] or 0 for row in self.rounds),
                'budgetAccountedUsd': self.charged,
                'unknownUsageRequests': sum(not row['usageKnown'] for row in self.rounds),
                'stopReason': self.stop_reason}
