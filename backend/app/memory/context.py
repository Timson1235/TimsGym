"""Context-window measurement (ported from calculate_context_usage in helper.py)."""

# Budget for the *conversation history* portion of the prompt. When the recent
# history exceeds THRESHOLD of this, we summarize older turns into Summary Memory.
CONV_TOKEN_BUDGET = 3000
THRESHOLD = 0.8


def estimate_tokens(text: str) -> int:
    return len(text or "") // 4  # ~4 chars per token (same heuristic as the course)


def usage_percent(text: str) -> float:
    return round(estimate_tokens(text) / CONV_TOKEN_BUDGET * 100, 1)


def should_summarize(history_text: str) -> bool:
    return estimate_tokens(history_text) > THRESHOLD * CONV_TOKEN_BUDGET
