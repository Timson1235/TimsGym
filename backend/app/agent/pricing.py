"""Standard global Claude estimates, verified 2026-11-11 against Anthropic pricing."""
def estimate_claude_cost(model, usage):
    if model == 'claude-haiku-5-5':
        prompt = sum(usage.get(k, 0) for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
        rates = (0.5, 2.5, 0.625, 0.05) if prompt > 100000 else (0.1, 0.5, 0.125, 0.01)
    elif model == 'claude-sonnet-5-5':
        rates = (2, 10, 2.5, 0.1)
    else:
        return None
    keys = ('input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')
    return sum(usage.get(k, 0) * rate for k, rate in zip(keys, rates)) / 1000000
