"""The AI coach loop — ported from the /api/ai/chat handler in server.ts.

Uses account-scoped training records, recent messages, and compressed history.
Detailed training facts are retrieved through deterministic tools.
"""
import json
import logging
import time
import uuid
from datetime import datetime
from typing import Any, Optional, Callable
from zoneinfo import ZoneInfo

from google import genai
from google.genai import types
from sqlmodel import Session

from .. import crud, tracing
from ..config import settings
from ..memory import context
from ..memory import conversational as memory
from ..memory import summary as summ
from ..memory import summary_jobs
from ..models import User
from . import tools
from .read_cache import RequestReadCache, READ_NAMES
from .claude_provider import run_claude_agent
from .tool_registry import ToolSession, RoundBudget, MAX_MODEL_ROUNDS, FINAL_RESPONSE_INSTRUCTION
from .prompts import build_system_instruction, mode_for, serialize_context, PROMPT_VERSION

logger = logging.getLogger(__name__)

_client: Optional[genai.Client] = None
if settings.GEMINI_API_KEY:
    _client = genai.Client(api_key=settings.GEMINI_API_KEY)

COACH_MODEL = settings.GEMINI_MODEL
COACH_FALLBACK_MODEL = settings.GEMINI_FALLBACK_MODEL
COACH_LAST_RESORT_MODEL = settings.GEMINI_LAST_RESORT_MODEL


def _is_billing_error(error: Exception) -> bool:
    message = str(error).lower()
    return (getattr(error, "code", None) == 402
            or "402" in message
            or "prepayment" in message
            or "billing" in message
            or "insufficient credit" in message)


def _generate_with_retry(client: genai.Client, model: str, contents: list, config: types.GenerateContentConfig, on_event=None):
    last_err = None
    models = list(dict.fromkeys([model, COACH_FALLBACK_MODEL, COACH_LAST_RESORT_MODEL]))
    for candidate_model in models:
        try:
            with tracing.Span("provider_attempt", candidate_model, {"model":candidate_model,"contents":contents,"config":config}) as attempt:
                visible_text = []
                if not on_event:
                    response = client.models.generate_content(model=candidate_model, contents=contents, config=config)
                    attempt.output(response)
                    return response
                on_event({"type": "reset"})
                on_event({"type": "status", "message": "Thinking through your request…"})
                parts, metadata, model_version, finish_reason = [], None, candidate_model, None
                for chunk in client.models.generate_content_stream(model=candidate_model, contents=contents, config=config):
                    if chunk.usage_metadata:
                        metadata = chunk.usage_metadata
                    model_version = chunk.model_version or model_version
                    if not chunk.candidates:
                        continue
                    candidate = chunk.candidates[0]
                    finish_reason = candidate.finish_reason or finish_reason
                    for part in (candidate.content.parts if candidate.content else []) or []:
                        parts.append(part)
                        if part.text and not part.thought:
                            visible_text.append(part.text)
                            on_event({"type": "delta", "text": part.text})
                            attempt.progress({"streamedText":"".join(visible_text)})
                if finish_reason is None:
                    raise RuntimeError("Gemini stream ended before a finish reason")
                if str(finish_reason).endswith("MAX_TOKENS"):
                    raise RuntimeError("Gemini response truncated; no tools executed for this round")
                if not parts:
                    raise RuntimeError("Gemini stream ended without content")
                response = types.GenerateContentResponse(
                    candidates=[types.Candidate(content=types.Content(role="model", parts=parts), finish_reason=finish_reason)],
                    usage_metadata=metadata, model_version=model_version,
                )
                attempt.output(response)
                return response
        except Exception as e:
            last_err = e
            msg = str(e)
            # Billing applies to the provider account, so model retries hide the cause.
            if _is_billing_error(e):
                raise
            is_transient = any(code in msg.upper() for code in [
                "503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED",
                "500", "INTERNAL", "FETCH FAILED", "TIMEOUT",
            ])
            if not is_transient:
                raise
            logger.warning("Gemini attempt failed (%s)", type(e).__name__)
            time.sleep(0.4)
    raise last_err


def _build_system_instruction(db: dict, active_workout_state: Optional[dict], conversation_summary=None) -> str:
    return build_system_instruction(db, active_workout_state, conversation_summary)


_FALLBACK_REPLIES = {
    "memory_saved": lambda d: f'🧠 **Erinnerung gespeichert!**\nIch habe **"{d}"** in deinem Profil gespeichert.',
    "memory_removed": lambda d: "🗑️ **Erinnerung entfernt!**\nIch habe die Information aus deinem Profil gelöscht.",
    "workout_logged": lambda d: f'✅ **Workout geloggt!**\n"{d["title"]}" mit {len(d["exercises"])} Übungen, Gesamtvolumen **{d["totalVolume"]:,}**.',
    "exercise_added": lambda d: f'✅ **Übung hinzugefügt!**\n"{d["name"]}" ({d["category"]} • {d["equipment"]}) zur Bibliothek hinzugefügt.',
    "profile_updated": lambda d: f'✅ **Profil aktualisiert!**\nZiel: **{d["primaryGoal"]}** ({d["experienceLevel"]}).',
    "workout_deleted": lambda d: f'🗑️ **Workout entfernt!**\n"{d["title"]}" ({d["date"]}) gelöscht.',
    "workout_proposed": lambda d: f'📋 **Vorschlag:** "{d["title"]}" mit {len(d["exercises"])} Übungen. Klick **„Workout starten"** — oder sag mir, was ich ändern soll.',
    "set_logged": lambda d: f'✅ **Satz geloggt:** {d["exerciseName"]} {d["weight"]}kg x {d["reps"]} ({d["setType"]}' + (f", RIR {d.get('rir')}" if d.get("rir") is not None else "") + ').',
    "log_corrected": lambda d: f'✏️ **Eintrag korrigiert:** {d["exerciseName"]} auf {d.get("weight")}kg x {d.get("reps")}.',
    "flag_opened": lambda d: f'🚩 **Flag gesetzt:** {d["note"]} ({d["type"]}).',
    "flag_resolved": lambda d: f'🏁 **Flag aufgelöst:** {d["query"]}.',
}


def _try_enqueue_summary(session: Session, user_id: int, thread_id: str) -> bool:
    """Queue persistence may fail without breaking the coach's response."""
    try:
        return summary_jobs.enqueue_if_needed(session, user_id, thread_id)
    except Exception as error:
        session.rollback()
        logger.warning("Summary enqueue failed (%s)", type(error).__name__)
        return False


def run_chat(
    session: Session,
    user: User,
    message: str,
    active_workout_state: Optional[dict],
    request_id: Optional[str] = None,
    thread_id: Optional[str] = None,
    on_event: Callable[[dict], None] | None = None,
) -> dict:
    request_started = time.perf_counter()
    request_id = request_id or str(uuid.uuid4())
    trace_steps: list[dict] = []
    first_text_ms = None
    def emit(event: dict):
        nonlocal first_text_ms
        if event.get("type") == "delta" and first_text_ms is None:
            first_text_ms = round((time.perf_counter() - request_started) * 1000)
        if on_event:
            on_event(event)
    emit({"type": "status", "message": "Loading your training context…"})
    with tracing.Span('context', 'Build model context', {'message':message}) as context_span:
        db = crud.get_user_database_state(session, user.id)
        if _client is None and not settings.CLAUDE_API_KEY:
            total_ms = round((time.perf_counter() - request_started) * 1000)
            trace = {
                "requestId": request_id,
                "totalMs": total_ms,
                "agentSteps": 0,
                "modelMs": 0,
                "toolMs": 0,
                "contextMs": total_ms,
                "persistenceMs": 0,
                "slowestStep": None,
                "steps": [],
            }
            return {
                "reply": "AI is not configured (CLAUDE_API_KEY or GEMINI_API_KEY missing).",
                "actionExecuted": None,
                "toolsUsed": [],
                "usage": None,
                "trace": trace,
                "db": db,
            }

        thread_id = thread_id or str(user.id)
        # Read a checkpoint and its pending tail; never generate a summary here.
        history, summary_ctx = summ.read_coach_context(session, user.id, thread_id)

        tool_session = ToolSession(active_workout_state is not None)
        available_tools = tool_session.declarations()

        # 2. System context + references to any compressed (summarized) history.
        system_instruction = _build_system_instruction(db, active_workout_state, summary_ctx)
        local_now = datetime.now(ZoneInfo("Europe/Berlin"))
        system_instruction += (
            "\n\n════ CURRENT TIME ════\n"
            f"Current local date and time: {local_now.isoformat(timespec='minutes')} "
            "(Europe/Berlin). Resolve relative dates such as today, yesterday and tomorrow "
            "from this value before calling tools."
        )

        # 3. Multi-turn contents: recent history + the new message.
        contents = [
            types.Content(role=("user" if m.role == "user" else "model"), parts=[types.Part(text=m.content)])
            for m in history
        ]
        contents.append(types.Content(role="user", parts=[types.Part(text=message)]))

        is_in_session = active_workout_state is not None
        thinking_config = types.ThinkingConfig(
            thinking_level="low" if is_in_session else "medium"
        )

        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            thinking_config=thinking_config,
            tools=[types.Tool(function_declarations=available_tools)],
        )
        trace_steps.append({
            "kind": "context",
            "name": "Database and context",
            "durationMs": round((time.perf_counter() - request_started) * 1000),
        })

        context_span.output({'system':system_instruction,
            'messages':[{'id':getattr(m,'id',None),'role':m.role,'content':m.content} for m in history],
            'summaryContext':summary_ctx, 'tools':[t['name'] for t in available_tools],
            'promptVersion':PROMPT_VERSION, 'promptMode':mode_for(active_workout_state),
            'contextSections':serialize_context(db, active_workout_state, summary_ctx),
            'initialTools':tool_session.initial,
            'estimatedContextTokens':context.estimate_tokens(system_instruction + '\n'.join(m.content for m in history) + message + json.dumps(available_tools))})

    # 4. Multi-step agent loop: the model may call tools, see the results, and keep
    #    reasoning until it returns a final text answer (bounded to avoid runaway).
    action_executed = None
    actions_executed = []
    mutation_attempted = False
    tools_used: list[str] = []  # debug: every tool invoked this turn
    reply_text = ""
    usage = None
    MAX_STEPS = MAX_MODEL_ROUNDS
    termination_reason = None
    read_cache = RequestReadCache()
    active_tool_span = None
    def execute_tool(name: str, args: dict, call_id: str = "") -> str:
        nonlocal active_tool_span
        with tracing.Span('tool', name, {'callId':call_id,'arguments':args}) as span:
            active_tool_span = span
            feedback = _execute_tool(name, args, call_id)
            span.output({'result':span.output_data,'feedbackToModel':feedback})
            return feedback

    def _execute_tool(name: str, args: dict, call_id: str = "") -> str:
        nonlocal action_executed, mutation_attempted
        tool_started = time.perf_counter()
        tool_status = "success"
        tools_used.append(name)
        labels = {
            "batch_retrieve": "Checking training records together…",
            "get_session_summary": "Checking previous workouts…",
            "get_workout_details": "Reading workout details…",
            "get_exercise_history": "Checking exercise history…",
            "resolve_exercise": "Matching the exercise…",
            "log_set": "Recording your set…",
            "correct_log": "Updating the recorded set…",
            "start_workout_session": "Preparing the workout card…",
        }
        emit({"type": "status", "message": labels.get(name, "Working on your request…")})
        try:
            spec = tool_session.validate(name, args)
            if not spec.read_only:
                mutation_attempted = True
                # Invalidate before execution: a handler may partially mutate then fail.
                read_cache.invalidate()
            if name == 'discover_tools':
                result = tool_session.discover(args['names'])
            elif name in READ_NAMES:
                result = read_cache.read(name, args, db, lambda: spec.handler(session, user.id, db, args, active_workout_state=active_workout_state))
            else:
                result = spec.handler(session, user.id, db, args, active_workout_state=active_workout_state, read_cache=read_cache)
            active_tool_span.output(result)
            memory.write_tool_log(session, user.id, thread_id, name, args, str(result), "success")
            if isinstance(result, dict) and "type" in result:
                action_executed = result
                actions_executed.append(result)

            if name == "start_workout_session":
                return ("The proposed workout now has a preview/start button. No workout has started. "
                        "Explain this exact plan and invite the user to click the start button or request changes. "
                        "Do not ask for a separate chat confirmation.")
            if name == "log_set":
                return (f"Set logged: {args.get('exercise_name')} {args.get('weight')} kg x {args.get('reps')} "
                        f"({args.get('set_type', 'working')}). Confirm to user in 1 compact line and name next block.")
            if name == "correct_log":
                return f"Set corrected: {result.get('data') if isinstance(result, dict) else 'updated'}."
            if name == "open_flag":
                return f"Flag opened: {args.get('note')} ({args.get('flag_type')})."
            if name == "resolve_flag":
                return f"Flag resolved: {args.get('keyword_or_id')}."
            if name in {"suggest_weight", "discover_tools", "batch_retrieve"}:
                feedback = read_cache.feedback(name, args, result, db) if name == 'batch_retrieve' else result
                if name in READ_NAMES:
                    feedback = read_cache.feedback(name, args, result, db)
                return json.dumps(feedback, ensure_ascii=False, separators=(",", ":"))
            if name in {"get_session_summary", "get_workout_details", "get_exercise_history", "resolve_exercise"}:
                return json.dumps(read_cache.feedback(name, args, result, db), ensure_ascii=False, separators=(",", ":"))
            return str(result) if result else "done"
        except Exception as error:
            tool_status = "error"
            active_tool_span.error(error)
            error_message = str(error)
            memory.write_tool_log(session, user.id, thread_id, name, args, None, "failed", error_message)
            logger.error(
                "AI tool failed %s",
                {
                    "event": "ai_tool_error",
                    "requestId": request_id,
                    "threadId": thread_id,
                    "tool": name,
                    "errorType": type(error).__name__,
                },
            )
            return f"error: {error}"
        finally:
            tool_trace = {
                "kind": "tool",
                "name": name,
                "durationMs": round((time.perf_counter() - tool_started) * 1000),
                "status": tool_status,
            }
            if tool_status == "error":
                tool_trace["error"] = error_message[:500]
            trace_steps.append(tool_trace)

    claude_failed = False
    provider_fallback = None
    if settings.CLAUDE_API_KEY:
        claude_messages = [
            {"role": "user" if item.role == "user" else "assistant", "content": item.content}
            for item in history
        ]
        claude_messages.append({"role": "user", "content": message})
        try:
            claude_result = run_claude_agent(
                api_key=settings.CLAUDE_API_KEY,
                model=settings.CLAUDE_MODEL,
                system_instruction=system_instruction,
                messages=claude_messages,
                tools=available_tools,
                get_tools=tool_session.declarations,
                handle_tool=execute_tool,
                on_trace_step=trace_steps.append,
                max_steps=MAX_STEPS,
                timeout_seconds=settings.CLAUDE_TIMEOUT_SECONDS,
                debug_payloads=settings.AI_DEBUG_PROMPTS,
                on_event=emit if on_event else None,
                prompt_caching=settings.CLAUDE_PROMPT_CACHING,
            )
            reply_text = claude_result["text"]
            usage = claude_result["usage"]
            termination_reason = claude_result.get('terminationReason')
        except Exception as error:
            emit({"type": "reset"})
            # Never replay a request on another model after a mutation succeeded.
            claude_failed = not mutation_attempted
            if mutation_attempted:
                reply_text = "Die abschließende KI-Antwort ist fehlgeschlagen. Änderungen könnten bereits gespeichert sein. Bitte prüfe den aktuellen Stand, bevor du die Anfrage wiederholst."
            elif not _client:
                reply_text = "Der KI-Coach konnte die Anfrage nicht abschließen. Bitte versuche es später erneut."
            if claude_failed and _client:
                reason = "timeout" if isinstance(error, TimeoutError) or "timed out" in str(error).lower() else "provider_error"
                provider_fallback = {"from": "claude", "to": "gemini", "reason": reason}
                tracing.event("fallback", "Claude to Gemini", output=provider_fallback)
                emit({"type": "status", "message": "Claude took too long; trying Gemini…" if reason == "timeout" else "Claude is unavailable; trying Gemini…"})
            else:
                emit({"type": "status", "message": "Finishing your request…"})
            logger.warning("Claude coach failed (%s); fallback=%s", type(error).__name__, claude_failed)

    # Fallback starts a fresh provider conversation: old references are not present.
    if claude_failed and _client:
        read_cache.invalidate()
    gemini_budget = RoundBudget()
    for step_index in range(MAX_STEPS if (not settings.CLAUDE_API_KEY or claude_failed) and _client else 0):
        finalizing = gemini_budget.exhausted or step_index == MAX_STEPS - 1
        if finalizing:
            contents.append(types.Content(role='user', parts=[types.Part(text=FINAL_RESPONSE_INSTRUCTION)]))
        current_tools = tool_session.declarations()
        config.tools = [types.Tool(function_declarations=current_tools)]
        config.tool_config = types.ToolConfig(function_calling_config=types.FunctionCallingConfig(mode='NONE' if finalizing else 'AUTO'))
        model_started = time.perf_counter()
        round_span = tracing.Span('model_round', f'Gemini round {step_index + 1}',
            {'model':COACH_MODEL,'contents':contents,'config':config})
        try:
            with tracing.parent_span(round_span.id):
                response = _generate_with_retry(_client, model=COACH_MODEL, contents=contents, config=config, on_event=emit if on_event else None)
            round_span.output(response)
            round_span.finish()
            metadata = getattr(response, "usage_metadata", None)
            if metadata:
                input_tokens = getattr(metadata, "prompt_token_count", 0) or 0
                output_tokens = getattr(metadata, "candidates_token_count", 0) or 0
                previous_usage = usage if usage and usage.get("provider") == "gemini" else {}
                usage = {
                    "provider": "gemini",
                    "model": getattr(response, "model_version", None) or COACH_MODEL,
                    "inputTokens": previous_usage.get("inputTokens", 0) + input_tokens,
                    "outputTokens": previous_usage.get("outputTokens", 0) + output_tokens,
                    "cacheCreationTokens": 0,
                    "cacheReadTokens": previous_usage.get("cacheReadTokens", 0) + (getattr(metadata, "cached_content_token_count", 0) or 0),
                    "totalTokens": previous_usage.get("totalTokens", 0) + input_tokens + output_tokens,
                    "estimatedCostUsd": 0,
                }
        except Exception as e:
            round_span.finish(e)
            trace_steps.append({
                "kind": "llm",
                "name": f"Gemini round {step_index + 1}",
                "durationMs": round((time.perf_counter() - model_started) * 1000),
                "step": step_index + 1,
                "provider": "gemini",
                "status": "error",
            })
            emit({"type": "reset"})
            msg = str(e)
            logger.warning("Gemini generation failed (%s)", type(e).__name__)
            if _is_billing_error(e):
                note = "⚠️ Der KI-Anbieter meldet ein Guthaben-/Abrechnungsproblem. Bitte prüfe das Billing des konfigurierten API-Projekts. Der Coach konnte die Anfrage nicht abschließen."
            elif "503" in msg or "UNAVAILABLE" in msg:
                note = "⚠️ Die Gemini-Server von Google sind gerade kurzzeitig überlastet (503 High Demand). Bitte sende die Nachricht gleich nochmal ab."
            elif "RESOURCE_EXHAUSTED" in msg or "429" in msg:
                note = "⚠️ Die KI ist gerade rate-limited (Gemini Free-Tier). Versuch's in einer Minute nochmal."
            else:
                note = "⚠️ Der AI-Coach hatte einen Fehler. Versuch's nochmal."
            reply_text = note
            break

        trace_steps.append({
            "kind": "llm",
            "name": f"Gemini round {step_index + 1}",
            "durationMs": round((time.perf_counter() - model_started) * 1000),
            "step": step_index + 1,
            "provider": "gemini",
            "toolsOffered": [item['name'] for item in current_tools],
            "finalResponseOnly": finalizing,
        })

        calls = response.function_calls or []
        gemini_budget.record([call.name for call in calls])
        if not calls:
            reply_text = (response.text or "").strip()
            termination_reason = 'round_limit' if finalizing else ('completed' if reply_text else 'empty_response')
            break

        # Record the model's tool-call turn, then execute each call and feed results back.
        if response.candidates:
            contents.append(response.candidates[0].content)
        for call in calls:
            args = dict(call.args or {})
            with tracing.parent_span(round_span.id):
                if finalizing:
                    feedback = 'No tool was executed: this is the final response-only round.'
                    with tracing.Span('tool', call.name, {'callId':call.id, 'arguments':args}) as rejected:
                        rejected.error(ValueError(feedback))
                        rejected.output({'feedbackToModel':feedback})
                elif call.name == 'discover_tools' and gemini_budget.discovery > 2:
                    feedback = 'Discovery round limit reached; no tools were activated.'
                    with tracing.Span('tool', call.name, {'callId':call.id, 'arguments':args}) as rejected:
                        rejected.error(ValueError(feedback))
                        rejected.output({'feedbackToModel':feedback})
                else:
                    feedback = execute_tool(call.name, args, call.id or "")
            contents.append(types.Content(
                role="user",
                parts=[types.Part.from_function_response(
                    name=call.name,
                    response={"result": feedback},
                )],
            ))
        if finalizing:
            termination_reason = 'round_limit'
            break

    if not reply_text:
        completed = [
            _FALLBACK_REPLIES[action['type']](action.get('data'))
            for action in actions_executed if action.get('type') in _FALLBACK_REPLIES
        ]
        if termination_reason == 'empty_response':
            reply_text = "The coach returned no answer. No further actions were performed."
        else:
            termination_reason = termination_reason or 'round_limit'
            reply_text = "The request reached its processing limit. No further actions were performed."
        if completed:
            reply_text += "\n\nCompleted actions:\n" + "\n".join(completed)
        reply_text += "\nPlease review the current state before continuing."

    tracing.event('loop_outcome', 'Agent loop outcome', output={
        'terminationReason':termination_reason, 'completedActions':len(actions_executed),
        'modelRounds':sum(item['kind'] == 'llm' for item in trace_steps)})
    emit({"type": "status", "message": "Saving your conversation…"})
    # Persist this turn for multi-turn continuity.
    persistence_started = time.perf_counter()
    with tracing.Span('persistence', 'Save conversation'):
        memory.write_message(session, user.id, thread_id, "user", message)
        memory.write_message(session, user.id, thread_id, "assistant", reply_text)
    trace_steps.append({
        "kind": "persistence",
        "name": "Persist response",
        "durationMs": round((time.perf_counter() - persistence_started) * 1000),
    })

    queue_started = time.perf_counter()
    with tracing.Span('queue', 'Queue background summary') as queue_span:
        summary_queued = _try_enqueue_summary(session, user.id, thread_id)
        queue_span.output({'queued':summary_queued})
    trace_steps.append({
        "kind": "persistence", "name": "Queue conversation summary",
        "durationMs": round((time.perf_counter() - queue_started) * 1000),
    })

    refresh_started = time.perf_counter()
    fresh_db = crud.get_user_database_state(session, user.id)
    trace_steps.append({
        "kind": "persistence",
        "name": "Refresh database",
        "durationMs": round((time.perf_counter() - refresh_started) * 1000),
    })
    total_ms = round((time.perf_counter() - request_started) * 1000)
    slowest = max(trace_steps, key=lambda item: item["durationMs"], default=None)
    trace = {
        "requestId": request_id,
        "totalMs": total_ms,
        "agentSteps": sum(1 for item in trace_steps if item["kind"] == "llm"),
        "modelMs": sum(item["durationMs"] for item in trace_steps if item["kind"] == "llm"),
        "toolMs": sum(item["durationMs"] for item in trace_steps if item["kind"] == "tool"),
        "contextMs": sum(item["durationMs"] for item in trace_steps if item["kind"] == "context"),
        "persistenceMs": sum(item["durationMs"] for item in trace_steps if item["kind"] == "persistence"),
        "slowestStep": slowest,
        "firstTextMs": first_text_ms,
        "providerFallback": provider_fallback,
        "terminationReason": termination_reason,
        "toolsOffered": tool_session.initial,
        "activatedTools": tool_session.names(),
        "toolDiscovery": tool_session.discovery_results,
        "readCache": {'hits':read_cache.hits, 'misses':read_cache.misses, 'generation':read_cache.generation},
        "promptMode": mode_for(active_workout_state),
        "promptVersion": PROMPT_VERSION,
        "steps": trace_steps,
    }
    # Detailed execution records are persisted separately, never printed here.
    return {
        "reply": reply_text,
        "actionExecuted": action_executed,
        "actionsExecuted": actions_executed,
        "activeWorkoutState": active_workout_state,
        "toolsUsed": tools_used,
        "usage": usage,
        "trace": trace,
        "db": fresh_db,
        "historyCompacted": False,
        "summaryQueued": summary_queued,
    }


def suggest_weight(session: Session, user: User, exercise_name: str, target_reps: int = 8, target_rpe: int = 8) -> dict:
    """Deterministic arithmetic weight recommendation based on RIR without LLM calls."""
    from .progression import recommend_progression
    db = crud.get_user_database_state(session, user.id)
    result = recommend_progression(db, exercise_name=exercise_name)
    targets = (result.get("next") or {}).get("sets") or []
    return {**result, "suggestedWeight": targets[0]["weight"] if targets else None,
            "suggestedReps": targets[0]["reps"] if targets else None,
            "recommendation": result["reasoning"]}
