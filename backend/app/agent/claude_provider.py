"""Minimal Anthropic Messages client using only the Python standard library."""
import json
import ssl
import time
from typing import Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

try:
    import certifi
except ImportError:  # Local minimal test environments can use the OS CA store.
    certifi = None


def _normalize_schema(value):
    if isinstance(value, list):
        return [_normalize_schema(item) for item in value]
    if not isinstance(value, dict):
        return value

    type_map = {
        "OBJECT": "object",
        "ARRAY": "array",
        "STRING": "string",
        "NUMBER": "number",
        "INTEGER": "integer",
        "BOOLEAN": "boolean",
    }
    normalized = {}
    for key, nested in value.items():
        if key == "type" and isinstance(nested, str):
            normalized[key] = type_map.get(nested.upper(), nested.lower())
        else:
            normalized[key] = _normalize_schema(nested)
    if normalized.get("type") == "object" and "additionalProperties" not in normalized:
        normalized["additionalProperties"] = False
    return normalized


def run_claude_agent(
    *,
    api_key: str,
    model: str,
    system_instruction: str,
    messages: list[dict],
    tools: list[dict],
    handle_tool: Callable[[str, dict, str], str],
    on_trace_step: Callable[[dict], None] | None = None,
    force_tool_name: str | None = None,
    max_steps: int = 4,
) -> dict:
    selected_tools = (
        [tool for tool in tools if tool["name"] == force_tool_name]
        if force_tool_name else tools
    )
    claude_tools = [
        {
            "name": tool["name"],
            "description": tool.get("description", ""),
            "input_schema": _normalize_schema(tool["parameters"]),
            "strict": True,
        }
        for tool in selected_tools
    ]
    conversation = list(messages)
    usage = {
        "provider": "claude",
        "model": model,
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheCreationTokens": 0,
        "cacheReadTokens": 0,
        "totalTokens": 0,
        "estimatedCostUsd": 0.0,
    }
    trace_steps = []

    for step in range(max_steps):
        payload = {
            "model": model,
            "max_tokens": 4096,
            "system": (
                system_instruction
                + (f"\n\nMANDATORY FOR THIS TURN: Call {force_tool_name}. "
                   "Do not answer with text instead." if force_tool_name else "")
            ),
            "messages": conversation,
            "tools": claude_tools,
        }
        if step == 0 and force_tool_name:
            payload["tool_choice"] = {
                "type": "auto",
                "disable_parallel_tool_use": True,
            }

        request = Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            method="POST",
        )
        model_started = time.perf_counter()
        try:
            ssl_context = ssl.create_default_context(
                cafile=certifi.where() if certifi else None
            )
            with urlopen(request, timeout=45, context=ssl_context) as response:
                result = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Claude HTTP {error.code}: {body[:500]}") from error
        finally:
            trace_step = {
                "kind": "llm",
                "name": f"Claude round {step + 1}",
                "durationMs": round((time.perf_counter() - model_started) * 1000),
                "step": step + 1,
                "provider": "claude",
            }
            trace_steps.append(trace_step)
            if on_trace_step:
                on_trace_step(trace_step)

        response_usage = result.get("usage", {})
        usage["inputTokens"] += response_usage.get("input_tokens", 0)
        usage["outputTokens"] += response_usage.get("output_tokens", 0)
        usage["cacheCreationTokens"] += response_usage.get("cache_creation_input_tokens", 0)
        usage["cacheReadTokens"] += response_usage.get("cache_read_input_tokens", 0)

        content = result.get("content", [])
        tool_calls = [block for block in content if block.get("type") == "tool_use"]
        if not tool_calls:
            text = "\n".join(
                block.get("text", "")
                for block in content
                if block.get("type") == "text"
            ).strip()
            usage["totalTokens"] = (
                usage["inputTokens"] + usage["outputTokens"]
                + usage["cacheCreationTokens"] + usage["cacheReadTokens"]
            )
            usage["estimatedCostUsd"] = (
                usage["inputTokens"] * 2
                + usage["outputTokens"] * 10
                + usage["cacheCreationTokens"] * 2.5
                + usage["cacheReadTokens"] * 0.2
            ) / 1_000_000
            return {"text": text, "usage": usage, "traceSteps": trace_steps}

        conversation.append({"role": "assistant", "content": content})
        tool_results = []
        for call in tool_calls:
            feedback = handle_tool(
                call.get("name", ""),
                call.get("input") or {},
                call.get("id", ""),
            )
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": call.get("id", ""),
                "content": feedback,
            })
        conversation.append({"role": "user", "content": tool_results})

    usage["totalTokens"] = (
        usage["inputTokens"] + usage["outputTokens"]
        + usage["cacheCreationTokens"] + usage["cacheReadTokens"]
    )
    usage["estimatedCostUsd"] = (
        usage["inputTokens"] * 2
        + usage["outputTokens"] * 10
        + usage["cacheCreationTokens"] * 2.5
        + usage["cacheReadTokens"] * 0.2
    ) / 1_000_000
    return {"text": "", "usage": usage, "traceSteps": trace_steps}


def generate_claude_text(*, api_key: str, model: str, system: str, prompt: str, max_tokens: int = 900) -> dict:
    """Small no-tools Claude call used by background jobs such as summarization."""
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": prompt}],
    }
    request = Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    ssl_context = ssl.create_default_context(cafile=certifi.where() if certifi else None)
    try:
        with urlopen(request, timeout=45, context=ssl_context) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Claude HTTP {error.code}: {body[:500]}") from error
    text_value = "\n".join(
        block.get("text", "") for block in result.get("content", []) if block.get("type") == "text"
    ).strip()
    raw_usage = result.get("usage", {})
    input_tokens = raw_usage.get("input_tokens", 0)
    output_tokens = raw_usage.get("output_tokens", 0)
    cache_creation = raw_usage.get("cache_creation_input_tokens", 0)
    cache_read = raw_usage.get("cache_read_input_tokens", 0)
    return {
        "text": text_value,
        "usage": {
            "provider": "claude", "model": model,
            "inputTokens": input_tokens, "outputTokens": output_tokens,
            "cacheCreationTokens": cache_creation, "cacheReadTokens": cache_read,
            "totalTokens": input_tokens + output_tokens + cache_creation + cache_read,
            "estimatedCostUsd": (
                input_tokens * 2 + output_tokens * 10
                + cache_creation * 2.5 + cache_read * 0.2
            ) / 1_000_000,
        },
    }
