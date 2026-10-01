"""Minimal Anthropic Messages client using only the Python standard library."""
import json
import ssl
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
    force_tool_name: str | None = None,
    max_steps: int = 4,
) -> str:
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
        try:
            ssl_context = ssl.create_default_context(
                cafile=certifi.where() if certifi else None
            )
            with urlopen(request, timeout=45, context=ssl_context) as response:
                result = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Claude HTTP {error.code}: {body[:500]}") from error

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
            return {"text": text, "usage": usage}

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
    return {"text": "", "usage": usage}
