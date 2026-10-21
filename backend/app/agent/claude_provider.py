"""Minimal Anthropic Messages client using only the Python standard library."""
import json
import logging
import ssl
import time
from typing import Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

try:
    import certifi
except ImportError:  # Local minimal test environments can use the OS CA store.
    certifi = None

logger = logging.getLogger(__name__)


def _request_json(
    request: Request,
    *,
    timeout_seconds: float,
    operation: str,
    model: str,
    step: int | None = None,
) -> dict:
    """Call Anthropic while recording safe timing and response diagnostics."""
    started = time.perf_counter()
    payload_bytes = len(request.data or b"")
    context = {
        "provider": "claude",
        "operation": operation,
        "model": model,
        "step": step,
        "timeoutSeconds": timeout_seconds,
        "requestBytes": payload_bytes,
    }
    ssl_context = ssl.create_default_context(
        cafile=certifi.where() if certifi else None
    )

    try:
        with urlopen(request, timeout=timeout_seconds, context=ssl_context) as response:
            result = json.loads(response.read().decode("utf-8"))
            logger.info(
                "Claude request completed %s",
                {
                    **context,
                    "status": getattr(response, "status", None),
                    "anthropicRequestId": getattr(response, "headers", {}).get("request-id"),
                    "durationMs": round((time.perf_counter() - started) * 1000),
                },
            )
            return result
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        logger.warning(
            "Claude request returned HTTP error %s",
            {
                **context,
                "status": error.code,
                "anthropicRequestId": error.headers.get("request-id"),
                "durationMs": round((time.perf_counter() - started) * 1000),
                "errorBody": body[:500],
            },
        )
        raise RuntimeError(f"Claude HTTP {error.code}: {body[:500]}") from error
    except Exception as error:
        logger.warning(
            "Claude request failed before receiving a response %s",
            {
                **context,
                "errorType": type(error).__name__,
                "error": str(error)[:500],
                "durationMs": round((time.perf_counter() - started) * 1000),
            },
        )
        raise


def _request_stream(request: Request, *, timeout_seconds: float, on_text: Callable[[str], None]) -> dict:
    """Reassemble complete Messages blocks; never execute partial tool JSON."""
    blocks: dict[int, dict] = {}
    partial_json: dict[int, str] = {}
    result = {"content": [], "usage": {}}
    stopped = False
    open_blocks = set()
    data_lines = []
    context = ssl.create_default_context(cafile=certifi.where() if certifi else None)
    try:
        with urlopen(request, timeout=timeout_seconds, context=context) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8").rstrip("\r\n")
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip(" "))
                    continue
                if line or not data_lines:
                    continue
                event = json.loads("\n".join(data_lines))
                data_lines = []
                kind = event.get("type")
                if kind == "error":
                    raise RuntimeError("Claude stream error: " + str(event.get("error", {}).get("type", "unknown")))
                if kind == "message_start":
                    result["usage"].update(event.get("message", {}).get("usage", {}))
                elif kind == "content_block_start":
                    blocks[event["index"]] = dict(event["content_block"])
                    open_blocks.add(event["index"])
                    block = blocks[event["index"]]
                    if block.get("type") == "text" and block.get("text"):
                        on_text(block["text"])
                elif kind == "content_block_delta":
                    index, delta = event["index"], event["delta"]
                    block = blocks[index]
                    if delta.get("type") == "text_delta":
                        block["text"] = block.get("text", "") + delta["text"]
                        on_text(delta["text"])
                    elif delta.get("type") == "input_json_delta":
                        partial_json[index] = partial_json.get(index, "") + delta["partial_json"]
                    elif delta.get("type") == "thinking_delta":
                        block["thinking"] = block.get("thinking", "") + delta["thinking"]
                    elif delta.get("type") == "signature_delta":
                        block["signature"] = block.get("signature", "") + delta["signature"]
                elif kind == "content_block_stop":
                    index = event["index"]
                    open_blocks.discard(index)
                    if index in partial_json:
                        value = json.loads(partial_json[index])
                        if not isinstance(value, dict):
                            raise ValueError("Tool input must be a JSON object")
                        blocks[index]["input"] = value
                elif kind == "message_delta":
                    result.update(event.get("delta", {}))
                    result["usage"].update(event.get("usage", {}))
                elif kind == "message_stop":
                    stopped = True
                    break
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Claude HTTP {error.code}: {body[:500]}") from error
    if not stopped or open_blocks:
        raise RuntimeError("Claude stream ended before all blocks were completed")
    if result.get("stop_reason") == "max_tokens":
        raise RuntimeError("Claude response was truncated; no tools were executed for this round")
    result["content"] = [blocks[index] for index in sorted(blocks)]
    return result


def _system_blocks(system_instruction: str, prompt_caching: bool) -> list[dict]:
    stable, marker, dynamic = system_instruction.partition("=== USER DATA ===")
    blocks = [{"type": "text", "text": stable}]
    if prompt_caching:
        blocks[0]["cache_control"] = {"type": "ephemeral"}
    if marker:
        blocks.append({"type": "text", "text": marker + dynamic})
    return blocks


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
    max_steps: int = 4,
    timeout_seconds: float = 45,
    debug_payloads: bool = False,
    on_event: Callable[[dict], None] | None = None,
    prompt_caching: bool = True,
) -> dict:
    # The full coaching toolset exceeds the provider's strict optional-field
    # limit. Ordinary tool calling keeps all tools available without grammar
    # compilation; the application handlers remain responsible for validation.
    claude_tools = [{
        "name": tool["name"],
        "description": tool.get("description", ""),
        "input_schema": _normalize_schema(tool["parameters"]),
        "strict": False,
    } for tool in tools]
    if prompt_caching and claude_tools:
        claude_tools[-1]["cache_control"] = {"type": "ephemeral"}
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
            "system": _system_blocks(system_instruction, prompt_caching),
            "messages": conversation,
            "tools": claude_tools,
        }
        if on_event:
            payload["stream"] = True
            on_event({"type": "reset"})
            on_event({"type": "status", "message": "Thinking through your request…"})
        if debug_payloads:
            # Opt-in only: the payload contains the full prompt and user data.
            print(json.dumps(
                {"event": "ai_debug_payload", "provider": "claude", "step": step + 1, "payload": payload},
                ensure_ascii=False,
            ))

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
        request_error = None
        try:
            if on_event:
                result = _request_stream(
                    request, timeout_seconds=timeout_seconds,
                    on_text=lambda text: on_event({"type": "delta", "text": text}),
                )
            else:
                result = _request_json(
                    request, timeout_seconds=timeout_seconds,
                    operation="coach", model=model, step=step + 1,
                )
            if result.get("stop_reason") == "max_tokens":
                raise RuntimeError("Claude response truncated; tool arguments were not executed")
        except Exception as error:
            request_error = type(error).__name__
            raise
        finally:
            trace_step = {
                "kind": "llm",
                "name": f"Claude round {step + 1}",
                "durationMs": round((time.perf_counter() - model_started) * 1000),
                "step": step + 1,
                "provider": "claude",
                "status": "error" if request_error else "success",
            }
            if request_error:
                trace_step["errorType"] = request_error
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
        trace_step["stopReason"] = result.get("stop_reason")
        trace_step["toolCalls"] = [call.get("name", "") for call in tool_calls]
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


def generate_claude_text(
    *,
    api_key: str,
    model: str,
    system: str,
    prompt: str,
    max_tokens: int = 900,
    timeout_seconds: float = 45,
) -> dict:
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
    result = _request_json(
        request,
        timeout_seconds=timeout_seconds,
        operation="summary",
        model=model,
    )
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
