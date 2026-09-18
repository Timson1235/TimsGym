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

    return f"""You are TimsGym AI — a knowledgeable, practical strength & hypertrophy coach for {profile['name']}. Reply in the user's language (usually German), like a sharp personal trainer: specific, grounded, honest. A brief natural acknowledgement is fine; skip corporate fluff and filler.

HOW YOU COACH
- When the user describes their situation or asks for a workout, PROPOSE one concrete session: a short warm-up, 4-6 main exercises with sets x reps and a load suggestion, brief form cues, and what to avoid + why (respect injuries/constraints). Then create it via the start_workout_session tool.
- Base load suggestions on the PRs and recent workouts below; progress sensibly (≈RIR 2, small increases) and reference what they did last time when useful.
- If a complaint sounds like a JOINT problem rather than muscle soreness, say so and suggest getting it checked — don't just train through it.
- Be decisive: give ONE good plan, not a menu of options.

TOOLS — actually call them, don't just talk about doing it
- Propose/create a workout → call `start_workout_session` (a title + the exercise names). This shows the user a confirm-card; it does NOT auto-start. Put the full plan + reasoning in your TEXT reply.
- Log a COMPLETED workout → `log_workout`.
- `save_personal_memory` → ONLY for DURABLE facts: long-term goals, chronic/recurring injuries, available equipment, lasting preferences. NEVER for one-off or "today"/"this week" info (e.g. temporary soreness from a hike) — just use those in your reasoning, do NOT save them.
- Also: add_exercise, update_profile, delete_workout, remove_personal_memory.

STYLE
- Never show internal IDs (wk_..., ex_...) to the user — refer to workouts by title and date.
- Lay a workout out clearly: warm-up, main lifts A/B/C…, optional finisher — readable, with concrete numbers.

=== USER DATA (use it; don't dump it back verbatim) ===
Profile: {profile['name']} · Goal: {profile['primaryGoal']} · Level: {profile['experienceLevel']}

Durable memories:
{memories_list}

Exercise library & PRs:
{exercise_records}

Recent workouts (most recent first):
{recent_workouts}

Active session:
{active_ctx}"""


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
        temperature=0.3,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
        tools=[types.Tool(function_declarations=TOOL_DECLARATIONS)],
    )

    # 4. Multi-step agent loop: the model may call tools, see the results, and keep
    #    reasoning until it returns a final text answer (bounded to avoid runaway).
    action_executed = None
    tools_used: list[str] = []  # debug: every tool invoked this turn
    reply_text = ""
    MAX_STEPS = 4
    for _ in range(MAX_STEPS):
        try:
            response = _client.models.generate_content(model="gemini-2.5-flash", contents=contents, config=config)
        except Exception as e:
            msg = str(e)
            print(f"[coach] generate_content failed: {msg[:200]}")
            note = ("⚠️ Die KI ist gerade rate-limited (Gemini Free-Tier). Versuch's in einer Minute nochmal."
                    if ("RESOURCE_EXHAUSTED" in msg or "429" in msg)
                    else "⚠️ Der AI-Coach hatte einen Fehler. Versuch's nochmal.")
            return {"reply": note, "actionExecuted": None, "toolsUsed": tools_used, "db": db}

        calls = response.function_calls or []
        if not calls:
            reply_text = (response.text or "").strip()
            break

        # Record the model's tool-call turn, then execute each call and feed results back.
        if response.candidates:
            contents.append(response.candidates[0].content)
        for call in calls:
            args = dict(call.args or {})
            handler = HANDLERS.get(call.name)
            if not handler:
                feedback = "unknown tool"
            else:
                tools_used.append(call.name)
                try:
                    r = handler(session, user.id, db, args)
                    memory.write_tool_log(session, user.id, thread_id, call.name, args, str(r), "success")
                    if r:
                        action_executed = r
                    if call.name == "start_workout_session":
                        feedback = ("Workout proposal created and shown to the user with a confirm button. "
                                    "Do NOT call start_workout_session again this turn. Now explain the plan "
                                    "and the reasoning in your text reply.")
                    else:
                        feedback = "done"
                except Exception as e:
                    memory.write_tool_log(session, user.id, thread_id, call.name, args, None, "failed", str(e))
                    feedback = f"error: {e}"
            contents.append(types.Content(
                role="tool",
                parts=[types.Part.from_function_response(name=call.name, response={"result": feedback})],
            ))

    if not reply_text:
        if action_executed and action_executed["type"] in _FALLBACK_REPLIES:
            reply_text = _FALLBACK_REPLIES[action_executed["type"]](action_executed["data"])
        else:
            reply_text = "Wie kann ich dir beim Training helfen?"

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
