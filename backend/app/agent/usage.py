"""Per-attempt accounting; partial usage and unknown billing are never zero cost."""
from datetime import date
from .pricing import estimate_claude_cost


class UsageLedger:
    def __init__(self, gemini_tier='unknown'):
        self.attempts = []
        self.gemini_tier = gemini_tier

    def add(self, provider, model, raw, complete=True):
        raw = raw or {}
        complete = complete and bool(raw)
        if provider == 'claude':
            inp = raw.get('input_tokens', 0)
            out = raw.get('output_tokens', 0)
            creation = raw.get('cache_creation_input_tokens', 0)
            cached = raw.get('cache_read_input_tokens', 0)
            thinking = (raw.get('output_tokens_details') or {}).get('thinking_tokens', 0)
            total = inp + out + creation + cached
            cost = estimate_claude_cost(model, raw) if complete else None
        else:
            inp = raw.get('prompt_token_count', 0) or 0
            thinking = raw.get('thoughts_token_count', 0) or 0
            out = (raw.get('candidates_token_count', 0) or 0) + thinking
            creation = 0
            cached = raw.get('cached_content_token_count', 0) or 0
            total = raw.get('total_token_count') or inp + out
            cost = None
            if complete and self.gemini_tier == 'free':
                cost = 0.0
            elif complete and self.gemini_tier == 'paid' and model == 'gemini-3.8-flash':
                multiplier = 1 if date.today() <= date(2026,12,31) else 2
                cost = (max(0,inp-cached)*.75 + cached*.075 + out*3.75)*multiplier/1000000
        self.attempts.append(dict(provider=provider,model=model,inputTokens=inp,outputTokens=out,
            thinkingTokens=thinking,cacheCreationTokens=creation,cacheReadTokens=cached,
            totalTokens=total,estimatedCostUsd=cost,usageComplete=complete,
            billingTier=self.gemini_tier if provider=='gemini' else 'paid'))

    def summary(self):
        if not self.attempts:
            return None
        providers=list(dict.fromkeys(r['provider'] for r in self.attempts))
        costs=[r['estimatedCostUsd'] for r in self.attempts]
        return dict(provider=providers[0] if len(providers)==1 else 'mixed',
            model=' + '.join(dict.fromkeys(r['model'] for r in self.attempts)),
            **{k:sum(r[k] for r in self.attempts) for k in ['inputTokens','outputTokens','thinkingTokens','cacheCreationTokens','cacheReadTokens','totalTokens']},
            estimatedCostUsd=sum(costs) if all(v is not None for v in costs) else None,
            knownCostUsd=sum(v for v in costs if v is not None),
            usageComplete=all(r['usageComplete'] for r in self.attempts),attempts=list(self.attempts))
