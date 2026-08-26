"""The AI coach loop — ported from the /api/ai/chat handler in server.ts.

Phase 2a: stateless (only the latest message is sent, like the current Node
app). Conversation memory + summarization arrive in Phase 2b.
"""
from typing import Any, Optional

from google import genai
from google.genai import types
from sqlmodel import Session

from .. import crud
from ..config import settings
from ..memory import context
from ..memory import conversational as memory
from ..memory import summary as summ
from ..models import User
from .tools import HANDLERS, TOOL_DECLARATIONS

# JIT tool: lets the model pull full detail behind a [Summary ID: xxx] reference.
EXPAND_DECL = {
    "name": "expand_summary",
    "description": "Retrieve the full detail behind a [Summary ID: xxx] reference from Summary Memory when you need specifics not present in the current context.",
    "parameters": {"type": "OBJECT", "properties": {
        "summary_id": {"type": "STRING", "description": "The summary id to expand."}
    }, "required": ["summary_id"]},
}

_client: Optional[genai.Client] = None
if settings.GEMINI_API_KEY:
    _client = genai.Client(api_key=settings.GEMINI_API_KEY)


def _build_system_instruction(db: dict, active_workout_state: Optional[dict]) -> str:
    profile = db["profile"]
    memories = profile.get("personalMemories") or []
    memories_list = "\n".join(f"- {m}" for m in memories) if memories else "- None saved yet."

    exercise_records = "\n".join(
        f"- {e['name']} ({e['category']}, {e['equipment']}): "
        + (f"[PR: {e['personalRecord']['maxWeight']} x {e['personalRecord']['maxReps']} reps, "
           f"Est 1RM: {e['personalRecord']['calculatedOneRepMax']} on {e['personalRecord']['date']}]"
           if e.get("personalRecord") else "[No PR logged yet]")
        for e in db["exercises"]
    )

    recent = []
    for w in db["workouts"][:10]:
        sets_line = "\n".join(
            f"   * {we['exerciseName']}: "
            + (", ".join(f"{s['weight']} x {s['reps']}" for s in we.get("sets", []) if s.get("completed")) or "No completed sets")
            for we in w.get("exercises", [])
        )
        recent.append(f"ID: {w['id']} | Date: {w['date']} | Title: \"{w['title']}\" | Total Vol: {w['totalVolume']}\n{sets_line}")
    recent_workouts = "\n\n".join(recent)

    active_ctx = "No active workout currently in progress."
    if active_workout_state and active_workout_state.get("exercises"):
        lines = []
        for we in active_workout_state["exercises"]:
            sets_str = " | ".join(
                f"Set {s.get('setNumber')} ({s.get('type')}): {s.get('weight')} x {s.get('reps')} "
                f"[{'DONE' if s.get('completed') else 'PENDING'}]" for s in we.get("sets", [])
            )
            lines.append(f"- {we['exerciseName']}: {sets_str}")
        active_ctx = f"Active Workout Session right now:\nTitle: {active_workout_state.get('title')}\nExercises in session:\n" + "\n".join(lines)

    return f"""You are GymPulse AI, a concise fitness assistant with direct read/write access to Tim's database.
RESPONSE STYLE: EXTREMELY MINIMALIST AND DIRECT.
- ZERO greetings, NO parasocial fluff. Give facts, numbers, or action confirmations immediately. Max 1-3 short lines.
- If the user shares a goal or constraint, call `save_personal_memory` to permanently remember it.

ACTIONS AVAILABLE: save_personal_memory, remove_personal_memory, log_workout, add_exercise, update_profile, delete_workout, start_workout_session.

WORKOUT PROPOSAL: When the user wants to start or create a workout, call `start_workout_session` with well-chosen exercises that respect the user's constraints (e.g. no legs today). This does NOT start the workout — it creates a PROPOSAL the user confirms with a button in the UI. In your text reply, present it as a proposal (list the exercises) and invite the user to confirm or adjust — do NOT claim it has started.

=== USER DATABASE CONTEXT ===
User Profile: Name: {profile['name']}, Goal: {profile['primaryGoal']}, Level: {profile['experienceLevel']}.

--- PERSONAL USER MEMORIES & PERMANENT GOALS ---
{memories_list}

--- EXERCISE LIBRARY & PRs ---
{exercise_records}

--- RECENT WORKOUTS ---
{recent_workouts}

--- CURRENT ACTIVE SESSION ---
{active_ctx}
============================="""


_FALLBACK_REPLIES = {
    "memory_saved": lambda d: f'🧠 **Erinnerung gespeichert!**\nIch habe **"{d}"** in deinem KI-Profil gespeichert.',
    "memory_removed": lambda d: "🗑️ **Erinnerung entfernt!**\nIch habe die Information aus deinem KI-Gedächtnis gelöscht.",
    "workout_logged": lambda d: f'✅ **Workout Logged!**\n"{d["title"]}" with {len(d["exercises"])} exercises, total volume **{d["totalVolume"]:,}**. PRs updated!',
    "exercise_added": lambda d: f'✅ **Movement Added!**\n"{d["name"]}" ({d["category"]} • {d["equipment"]}) added to your library.',
    "profile_updated": lambda d: f'✅ **Profile Updated!**\nGoals set to **{d["primaryGoal"]}** ({d["experienceLevel"]} level).',
    "workout_deleted": lambda d: f'🗑️ **Workout Removed!**\nDeleted "{d["title"]}" ({d["date"]}) from history.',
    "workout_proposed": lambda d: f'📋 **Vorschlag:** "{d["title"]}" mit {len(d["exercises"])} Übungen. Prüf die Übungen unten und klick **„Workout starten"** — oder sag mir, was ich ändern soll.',
}


def run_chat(session: Session, user: User, message: str, active_workout_state: Optional[dict]) -> dict:
    db = crud.get_user_database_state(session, user.id)
    if _client is None:
        return {"reply": "AI is not configured (GEMINI_API_KEY missing).", "actionExecuted": None, "db": db}

    thread_id = str(user.id)

    # 1. Auto-summarize: if recent history has grown past budget, compress older turns.
    history = memory.read_recent_messages(session, user.id, thread_id, limit=20)
    if context.should_summarize("\n".join(m.content for m in history)):
        summ.summarize_conversation(session, user.id, thread_id)
        history = memory.read_recent_messages(session, user.id, thread_id, limit=20)

    # 2. System context + references to any compressed (summarized) history.
    system_instruction = _build_system_instruction(db, active_workout_state)
    summary_ctx = summ.read_summary_context(session, user.id, thread_id)
    if summary_ctx:
        system_instruction += "\n\n" + summary_ctx

    # 3. Multi-turn contents: recent history + the new message.
    contents = [
        types.Content(role=("user" if m.role == "user" else "model"), parts=[types.Part(text=m.content)])
        for m in history
    ]
    contents.append(types.Content(role="user", parts=[types.Part(text=message)]))

    config = types.GenerateContentConfig(
        system_instruction=system_instruction,
        temperature=0.2,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
        tools=[types.Tool(function_declarations=TOOL_DECLARATIONS)],
    )

    # 4. One Gemini call (quota-friendly). Summary text is already injected into
    #    the context, so no model-driven expand round-trip is needed.
    try:
        response = _client.models.generate_content(model="gemini-2.5-flash", contents=contents, config=config)
    except Exception as e:
        msg = str(e)
        print(f"[coach] generate_content failed: {msg[:200]}")
        note = ("⚠️ The AI is rate-limited right now (Gemini free-tier quota). Please try again in a minute."
                if ("RESOURCE_EXHAUSTED" in msg or "429" in msg)
                else "⚠️ The AI Coach hit an error. Please try again.")
        return {"reply": note, "actionExecuted": None, "db": db}

    action_executed = None
    tools_used: list[str] = []  # debug: every tool the model invoked this turn
    for call in (response.function_calls or []):
        handler = HANDLERS.get(call.name)
        if not handler:
            continue
        tools_used.append(call.name)
        args = dict(call.args or {})
        try:
            r = handler(session, user.id, db, args)
            memory.write_tool_log(session, user.id, thread_id, call.name, args, str(r), "success")
            if r:
                action_executed = r
        except Exception as e:
            memory.write_tool_log(session, user.id, thread_id, call.name, args, None, "failed", str(e))

    reply_text = (response.text or "").strip()
    if not reply_text:
        if action_executed and action_executed["type"] in _FALLBACK_REPLIES:
            reply_text = _FALLBACK_REPLIES[action_executed["type"]](action_executed["data"])
        else:
            reply_text = "How else can I assist your workout today?"

    # Persist this turn for multi-turn continuity.
    memory.write_message(session, user.id, thread_id, "user", message)
    memory.write_message(session, user.id, thread_id, "assistant", reply_text)

    fresh_db = crud.get_user_database_state(session, user.id)
    return {"reply": reply_text, "actionExecuted": action_executed, "toolsUsed": tools_used, "db": fresh_db}


def suggest_weight(session: Session, user: User, exercise_name: str, target_reps: int = 8, target_rpe: int = 8) -> Optional[dict]:
    """AI weight recommendation for an exercise (ported from /api/ai/suggest-weight)."""
    if _client is None:
        return None
    db = crud.get_user_database_state(session, user.id)
    ex = next((e for e in db["exercises"] if e["name"].lower() == (exercise_name or "").lower()), None)
    pr = (ex or {}).get("personalRecord")
    pr_line = (f"Current PR: {pr['maxWeight']}kg x {pr['maxReps']} (est 1RM {pr['calculatedOneRepMax']})."
               if pr else "No PR logged yet.")

    prompt = f"""You are a strength coach. Recommend a working weight (kg) for "{exercise_name}".
{pr_line}
Target: {target_reps} reps at RPE {target_rpe}. User goal: {db['profile']['primaryGoal']}, level {db['profile']['experienceLevel']}.
Return JSON with keys: "suggestedWeight" (number, rounded to nearest 5), "suggestedReps" (number),
"recommendation" (short 1 sentence), "reasoning" (1-2 sentences on progressive overload)."""

    import json
    response = _client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.3,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    try:
        return json.loads(response.text or "{}")
    except Exception:
        return None
