"""Minimal Anthropic Messages client using only the Python standard library."""
import json
from http.client import IncompleteRead
from itertools import chain
from .pricing import estimate_claude_cost
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

from .. import tracing
from .tool_registry import RoundBudget, MAX_MODEL_ROUNDS, FINAL_RESPONSE_INSTRUCTION
from .context_selection import ContextSelection, CONTROL_SCHEMA, INSTRUCTION
from .tool_registry import REGISTRY
from copy import deepcopy
from jsonschema import ValidationError

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
            },
        )
        raise RuntimeError(f"Claude HTTP {error.code}: {body[:500]}") from error
    except Exception as error:
        logger.warning(
            "Claude request failed before receiving a response %s",
            {
                **context,
                "errorType": type(error).__name__,
                "durationMs": round((time.perf_counter() - started) * 1000),
            },
        )
        raise


class IncompleteStream(RuntimeError):
    def __init__(self, message, usage, diagnostics):
        super().__init__(message)
        self.partial_usage = deepcopy(usage)
        self.diagnostics = diagnostics


def _request_stream(request: Request, *, timeout_seconds: float, on_text: Callable[[str], None]) -> dict:
    """Reassemble complete Messages blocks; never execute partial tool JSON."""
    blocks: dict[int, dict] = {}
    partial_json: dict[int, str] = {}
    result = {"content": [], "usage": {}}
    stopped = False
    open_blocks = set()
    data_lines = []
    event_counts = {}
    request_id = None
    context = ssl.create_default_context(cafile=certifi.where() if certifi else None)
    try:
        with urlopen(request, timeout=timeout_seconds, context=context) as response:
            request_id = getattr(response, 'headers', {}).get('request-id')
            # Flush a final SSE event even when the server omits its trailing blank line.
            for raw_line in chain(response, [b'\n']):
                line = raw_line.decode("utf-8").rstrip("\r\n")
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip(" "))
                    continue
                if line or not data_lines:
                    continue
                event = json.loads("\n".join(data_lines))
                data_lines = []
                kind = event.get("type")
                event_counts[kind] = event_counts.get(kind, 0) + 1
                if kind == "error":
                    raise RuntimeError("Claude stream error: " + str(event.get("error", {}).get("type", "unknown")))
                if kind == "message_start":
                    result['model'] = event.get('message', {}).get('model')
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
    except (TimeoutError, ConnectionError, IncompleteRead) as error:
        raise IncompleteStream("Claude stream transport interrupted", result['usage'],
            {'requestId': request_id, 'eventCounts': event_counts,
             'transportError': type(error).__name__, 'openBlockIndexes': sorted(open_blocks)}) from error
    if not stopped or open_blocks:
        raise IncompleteStream("Claude stream ended before all blocks were completed", result['usage'],
            {'requestId':request_id,'eventCounts':event_counts,'messageStopped':stopped,
             'openBlockIndexes':sorted(open_blocks),'stopReason':result.get('stop_reason')})
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
    max_steps: int = MAX_MODEL_ROUNDS,
    timeout_seconds: float = 45,
    debug_payloads: bool = False,
    on_event: Callable[[dict], None] | None = None,
    prompt_caching: bool = True,
    get_tools: Callable[[], list[dict]] | None = None,
    max_output_tokens: int = 4096,
    on_usage: Callable | None = None,
    context_selection: bool = False,
) -> dict:
    conversation = list(messages)
    selection = ContextSelection(messages) if context_selection else None
    if selection:
        system_instruction += '\n' + INSTRUCTION
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

    stream_retried = False
    mutation_attempted = False
    seen_read_results = set()
    stalled_read_rounds = 0
    budget = RoundBudget()
    termination_reason = 'round_limit'
    for step in range(max_steps):
        finalizing = budget.exhausted or step == max_steps - 1
        if finalizing:
            conversation.append({'role': 'user', 'content': FINAL_RESPONSE_INSTRUCTION})
        current_tools = get_tools() if get_tools else tools
        available_tools = list(current_tools)
        if selection and selection.tool_names is not None:
            current_tools = [tool for tool in current_tools
                             if tool['name'] in selection.tool_names or tool['name'] == 'discover_tools']
        completion_round = (not finalizing and any(t['name'] == 'start_workout_session' for t in available_tools)
                            and (budget.ordinary >= budget.ordinary_limit - 2 or stalled_read_rounds >= 2))
        if completion_round:
            current_tools = [t for t in available_tools if t['name'] == 'start_workout_session']
            conversation.append({'role': 'user', 'content':
                'Retrieval is now closed for this request. Use the available confirmed evidence '
                'to create the requested workout preview now, if enough information is available. '
                'For missing setup propose clearly labeled starting targets; never override a hold '
                'or invent achieved performance. If essential information is missing, ask one '
                'focused clarification instead. Do not claim a preview without tool success.'})
        offered = {tool['name'] for tool in current_tools}
        claude_tools = [{
            'name': tool['name'], 'description': tool.get('description', ''),
            'input_schema': _normalize_schema(tool['parameters']), 'strict': False,
        } for tool in current_tools]
        if selection:
            for tool in claude_tools:
                tool['input_schema'].setdefault('properties', {})['_context'] = deepcopy(CONTROL_SCHEMA)
        if prompt_caching and claude_tools:
            claude_tools[-1]['cache_control'] = {'type': 'ephemeral'}
        payload = {
            "model": model,
            "max_tokens": max_output_tokens,
            "system": _system_blocks(system_instruction, prompt_caching),
            "messages": selection.view(conversation) if selection else conversation,
            "tools": claude_tools,
        }
        if finalizing:
            payload['tool_choice'] = {'type': 'none'}
            if selection:
                # No tools can run in this round, so their schemas serve no purpose.
                payload.pop('tools')
                payload.pop('tool_choice')
                offered = set()
        if on_event:
            payload["stream"] = True
            on_event({"type": "reset"})
            on_event({"type": "status", "message": "Thinking through your request…"})
        # Full payloads go to private trace storage, never console output.

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
        model_span = tracing.Span('model_round', f'Claude round {step + 1}', payload)
        streamed_text = []
        def emit_text(text):
            streamed_text.append(text)
            on_event({'type':'delta','text':text})
            model_span.progress({'streamedText':''.join(streamed_text)})
        model_started = time.perf_counter()
        request_error = None
        accounted = False
        try:
            if on_event:
                try:
                    result = _request_stream(request, timeout_seconds=timeout_seconds, on_text=emit_text)
                except IncompleteStream as error:
                    if on_usage:
                        on_usage(error.partial_usage, False)
                    accounted = True
                    tracing.event('stream_failure', 'Incomplete Claude stream', output=error.diagnostics)
                    if stream_retried or mutation_attempted:
                        raise
                    stream_retried = True
                    on_event({'type':'reset'})
                    on_event({'type':'status','message':'Antwortübertragung unterbrochen; derselbe Schritt wird einmal wiederholt…'})
                    retry_payload = dict(payload)
                    retry_payload.pop('stream', None)
                    retry_request = Request(request.full_url, data=json.dumps(retry_payload).encode(),
                                            headers=dict(request.headers), method='POST')
                    accounted = False
                    with tracing.Span('provider_attempt', 'Claude non-stream recovery', retry_payload) as retry_span:
                        result = _request_json(retry_request, timeout_seconds=timeout_seconds,
                                               operation='stream_recovery', model=model, step=step+1)
                        retry_span.output(result)
            else:
                result = _request_json(
                    request, timeout_seconds=timeout_seconds,
                    operation="coach", model=model, step=step + 1,
                )
            if on_usage:
                on_usage(result.get("usage", {}), True)
            accounted = True
            model_span.output(result)
            if result.get("stop_reason") == "max_tokens":
                raise RuntimeError("Claude response truncated; tool arguments were not executed")
            content = result.get("content") or []
            has_tools = any(block.get("type") == "tool_use" for block in content)
            has_text = any(block.get("type") == "text" and block.get("text", "").strip() for block in content)
            if (result.get("stop_reason") == "tool_use" and not has_tools) or not (has_tools or has_text):
                raise RuntimeError("Claude returned no usable response; no tools were executed for this round")
        except Exception as error:
            if on_usage and not accounted:
                on_usage(getattr(error, "partial_usage", {}), False)
            request_error = type(error).__name__
            model_span.error(error)
            raise
        finally:
            model_span.finish()
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
        round_cost = estimate_claude_cost(model, response_usage)
        usage["estimatedCostUsd"] = (usage["estimatedCostUsd"] + round_cost
                                     if usage["estimatedCostUsd"] is not None and round_cost is not None else None)
        usage["inputTokens"] += response_usage.get("input_tokens", 0)
        usage["outputTokens"] += response_usage.get("output_tokens", 0)
        usage["cacheCreationTokens"] += response_usage.get("cache_creation_input_tokens", 0)
        usage["cacheReadTokens"] += response_usage.get("cache_read_input_tokens", 0)

        content = result.get("content", [])
        tool_calls = [block for block in content if block.get("type") == "tool_use"]
        budget.record([call.get('name', '') for call in tool_calls])
        trace_step["toolsOffered"] = sorted(offered)
        trace_step['finalResponseOnly'] = finalizing
        trace_step['contextSelection'] = bool(selection)
        trace_step['contextCharacters'] = len(json.dumps(payload['messages']))
        if selection:
            trace_step['contextBudget'] = dict(selection.stats)
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
            return {"text": text, "usage": usage, "traceSteps": trace_steps,
                    'terminationReason': 'round_limit' if finalizing else ('completed' if text else 'empty_response')}

        conversation.append({"role": "assistant", "content": content})
        tool_results = []
        round_new_reads = 0
        round_reads = 0
        round_mutation = False
        for call in tool_calls:
            with tracing.parent_span(model_span.id):
                name = call.get('name', '')
                rejection = None
                if finalizing:
                    rejection = 'No tool was executed: this is the final response-only round.'
                elif name not in offered:
                    rejection = f'Tool {name} is inactive. Discover it first and call it next round.'
                elif name == 'discover_tools' and budget.discovery > 2:
                    rejection = 'Discovery round limit reached; no tools were activated.'
                if rejection:
                    with tracing.Span('tool', name, {'callId':call.get('id', ''), 'arguments':call.get('input')}) as rejected:
                        rejected.error(ValueError(rejection))
                        rejected.output({'feedbackToModel':rejection})
                    feedback = rejection
                else:
                    arguments = call.get('input') or {}
                    control = None
                    try:
                        if selection:
                            arguments, control = selection.split(arguments, conversation)
                            unknown = set((control or {}).get('tools', [])) - set(REGISTRY)
                            if unknown:
                                raise ValueError('Unknown context tool names: ' + ', '.join(sorted(unknown)))
                    except (ValueError, TypeError, ValidationError) as error:
                        feedback = 'Context selection rejected; no tool executed: ' + str(error)
                    else:
                        if name in REGISTRY and not REGISTRY[name].read_only:
                            mutation_attempted = True
                        feedback = handle_tool(name, arguments, call.get('id', ''))
                        if name in REGISTRY and not REGISTRY[name].read_only:
                            round_mutation = True
                            seen_read_results.clear()
                        elif name != 'discover_tools':
                            round_reads += 1
                            try:
                                data = json.loads(feedback)
                                items = data.get('results', []) if name == 'batch_retrieve' else [{'success': True, 'tool':name, 'result':data}]
                                for item in items:
                                    if not item.get('success') or 'result' not in item:
                                        continue
                                    signature = json.dumps([item.get('tool'), item['result']], sort_keys=True)
                                    if signature not in seen_read_results:
                                        seen_read_results.add(signature)
                                        round_new_reads += 1
                            except (ValueError, TypeError, AttributeError):
                                pass
                        if selection:
                            selection.apply(control)
                            if name == 'discover_tools' and selection.tool_names is not None:
                                selection.tool_names.update(arguments.get('names', []))
                            if name in REGISTRY and REGISTRY[name].read_only:
                                selection.read_ids.add(call.get('id', ''))
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": call.get("id", ""),
                "content": feedback,
            })
        stalled_read_rounds = (stalled_read_rounds + 1 if round_reads and not round_new_reads and not round_mutation else 0)
        trace_step['newReadResults'] = round_new_reads
        trace_step['stalledReadRounds'] = stalled_read_rounds
        trace_step['completionRound'] = completion_round
        conversation.append({"role": "user", "content": tool_results})
        if finalizing:
            break

    usage["totalTokens"] = (
        usage["inputTokens"] + usage["outputTokens"]
        + usage["cacheCreationTokens"] + usage["cacheReadTokens"]
    )
    return {"text": "", "usage": usage, "traceSteps": trace_steps, 'terminationReason': termination_reason}


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
            "estimatedCostUsd": estimate_claude_cost(model, raw_usage),
        },
    }
