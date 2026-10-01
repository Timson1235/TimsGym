"""The AI coach loop — ported from the /api/ai/chat handler in server.ts.

Phase 2a: stateless (only the latest message is sent, like the current Node
app). Conversation memory + summarization arrive in Phase 2b.
"""
import re
import time
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
from . import tools
from .claude_provider import run_claude_agent
from .tools import HANDLERS, TOOL_DECLARATIONS
from .workout_flow import (
    WORKOUT_CONFIRMATION_QUESTION,
    has_pending_workout_draft,
    is_explicit_workout_confirmation,
)

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

COACH_MODEL = settings.GEMINI_MODEL
COACH_FALLBACK_MODEL = settings.GEMINI_FALLBACK_MODEL
COACH_LAST_RESORT_MODEL = settings.GEMINI_LAST_RESORT_MODEL


def _generate_with_retry(client: genai.Client, model: str, contents: list, config: types.GenerateContentConfig):
    last_err = None
    models = list(dict.fromkeys([model, COACH_FALLBACK_MODEL, COACH_LAST_RESORT_MODEL]))
    for candidate_model in models:
        try:
            return client.models.generate_content(
                model=candidate_model, contents=contents, config=config
            )
        except Exception as e:
            last_err = e
            msg = str(e)
            is_transient = any(code in msg.upper() for code in [
                "503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED",
                "500", "INTERNAL", "FETCH FAILED", "TIMEOUT",
            ])
            if not is_transient:
                raise
            print(f"[coach] Gemini {candidate_model} unavailable; trying next model: {msg[:80]}")
            time.sleep(0.4)
    raise last_err


def _claims_workout_started_without_tool(reply: str, action_executed: Optional[dict]) -> bool:
    if action_executed and action_executed.get("type") == "workout_proposed":
        return False
    return bool(re.search(
        r"(workout|training).{0,30}(gestartet|erstellt|vorbereitet)|tool.{0,30}(genutzt|verwendet|erstellt)",
        reply,
        flags=re.IGNORECASE,
    ))


MAIN_LIFT_KEYWORDS = [
    "bankdrücken", "schrägbank", "bench press",
    "kniebeuge", "squat", "front squat",
    "kreuzheben", "deadlift", "rdl",
    "schulterdrücken", "overhead press", "military press",
    "klimmzüge", "pull-up", "latzug", "lat pulldown",
    "rudern", "barbell row",
]


def _format_main_lifts(db: dict) -> str:
    """Extract and format recent 3-session progression for key compound movements."""
    exercises = db.get("exercises", [])
    workouts = db.get("workouts", [])

    main_lifts = []
    seen = set()
    for kw in MAIN_LIFT_KEYWORDS:
        for ex in exercises:
            name = ex.get("name", "")
            if kw in name.lower() and name.lower() not in seen:
                seen.add(name.lower())
                main_lifts.append(name)
                break
        if len(main_lifts) >= 5:
            break

    if not main_lifts:
        main_lifts = [e["name"] for e in exercises[:4]]

    lines = []
    for lift in main_lifts:
        lift_lower = lift.lower()
        occurrences = []
        for w in workouts:
            for we in w.get("exercises", []):
                if lift_lower in we.get("exerciseName", "").lower():
                    completed_sets = [s for s in we.get("sets", []) if s.get("completed")]
                    if completed_sets:
                        occurrences.append({
                            "date": w.get("date", ""),
                            "sets": completed_sets,
                        })
                    break
            if len(occurrences) >= 3:
                break

        if not occurrences:
            lines.append(f"  {lift}: [Noch keine Werte geloggt]")
            continue

        occurrences_chrono = list(reversed(occurrences))
        step_strs = []
        dates = []
        for occ in occurrences_chrono:
            dt = occ["date"]
            short_dt = dt[5:].replace("-", ".") if len(dt) >= 10 else dt
            dates.append(short_dt)

            c_sets = occ["sets"]
            weights = [s.get("weight") for s in c_sets]
            reps = [s.get("reps") for s in c_sets]
            types = [s.get("type", "working") for s in c_sets]
            rpes = [s.get("rpe") for s in c_sets]

            if len(set(weights)) == 1 and len(set(reps)) == 1 and all(t == "working" for t in types):
                w_val = weights[0]
                r_val = reps[0]
                rir_val = round(10.0 - rpes[-1], 1) if rpes[-1] is not None else None
                rir_str = f" RIR{rir_val}" if rir_val is not None else ""
                step_strs.append(f"{len(c_sets)}x{r_val}@{w_val}{rir_str}")
            else:
                compact_sets = []
                for s in c_sets:
                    w = s.get("weight", 0)
                    r = s.get("reps", 0)
                    tag = "(w)" if s.get("type") == "warmup" else ""
                    compact_sets.append(f"{w}x{r}{tag}")
                step_strs.append(",".join(compact_sets))

        progression = " → ".join(step_strs)
        date_str = ", ".join(dates)
        lines.append(f"  {lift}:  {progression}   [{date_str}]")

    return "\n".join(lines)


def _build_system_instruction(db: dict, active_workout_state: Optional[dict]) -> str:
    profile = db.get("profile", {})
    name = profile.get("name", "Athlete")
    goal = profile.get("primaryGoal", "Hypertrophy")
    level = profile.get("experienceLevel", "Intermediate")

    memories = profile.get("personalMemories") or []
    constraints_str = ", ".join(memories) if memories else "Keine"

    flags = profile.get("openFlags") or []
    if flags:
        flags_str = ", ".join(f"[{f.get('type', 'symptom')} seit {f.get('date', 'unbekannt')}, ungeprüft: {f.get('note', '')}]" for f in flags)
    else:
        flags_str = "Keine"

    aktive_session_str = "Keine aktive Session (Planungs-Modus)."
    zuletzt_geloggt_str = "Noch nichts geloggt."

    if active_workout_state and isinstance(active_workout_state.get("exercises"), list) and active_workout_state["exercises"]:
        ex_list = active_workout_state["exercises"]
        n = len(ex_list)
        done = [e.get("exerciseName") for e in ex_list if all(s.get("completed") for s in e.get("sets", [])) and e.get("sets")]
        offen = [e.get("exerciseName") for e in ex_list if e.get("exerciseName") not in done]
        block_idx = len(done) + 1 if offen else n
        aktive_session_str = f"{block_idx}/{n}, erledigt: [{', '.join(done)}], offen: [{', '.join(offen)}]"

        last_completed = None
        for we in reversed(ex_list):
            for s in reversed(we.get("sets", [])):
                if s.get("completed"):
                    rir_display = round(10.0 - s["rpe"], 1) if s.get("rpe") is not None else "-"
                    last_completed = f"{we.get('exerciseName')} {s.get('weight')}x{s.get('reps')} ({s.get('type', 'working')}, RIR {rir_display})"
                    break
            if last_completed:
                break
        if last_completed:
            zuletzt_geloggt_str = last_completed
        else:
            zuletzt_geloggt_str = "Noch kein Satz in der aktiven Session geloggt."

    user_data = f"""=== USER DATA ===
Profil: {name}, Ziel: {goal}, Level: {level}
Dauerhafte Constraints: {constraints_str}
Offene Flags: {flags_str}
Aktive Session: {aktive_session_str}
Zuletzt geloggt: {zuletzt_geloggt_str}
Hauptlifte, letzte 3 Werte:
{_format_main_lifts(db)}
Alles Weitere über Tools abrufen."""

    return f"""You are TimsGym AI — a strength & hypertrophy coach for {name}.
Reply in the user's language (usually German). Be specific, grounded, honest.
Never flatter, never pad. If a load, a plan or an exercise choice is wrong
for the user's goal, say so plainly and say why.

════ THE BAR ════
A generic coach prescribes. You reason from THIS user's data.

1. Every load and rep prescription traces to something concrete: a logged
   set, an RIR, a constraint, or the user's goal. Name that link in one
   clause — "3x5 @ 75, letzte Woche 70 bei RIR 3+". Never prescribe a
   number you cannot justify from USER DATA.
2. Rep ranges follow the GOAL, not convention. State the reason when the
   user is likely to wonder (main lifts low reps for max strength if the
   goal is power/jump; accessories higher).
3. Before replying, scan RECENT DATA for:
   - a lift that stalled or moved backwards
   - actual load far above or below what was prescribed
   - a left/right asymmetry
   - an open flag that today's exercises touch
   - a jump in load large enough to be a typo or a risk
   Surface AT MOST ONE of these per reply, the most consequential, in one
   or two sentences. If none is consequential, surface none. Do not
   narrate that you checked.
4. "Warum X?" is answered with the mechanism, in 2-4 sentences. Not with
   authority, not with a list of benefits. If the honest answer is
   convention or habit, say that.
5. If the user challenges a prescription and is right, say so in the first
   sentence and change the plan. Do not defend a weaker option.
6. Never evaluate a set by how heavy it was. Evaluate it against the
   prescription, the RIR and the goal. "Schwer" is not "gut".

════ TWO MODES ════
PLANNING (no active session)
  Propose ONE concrete session: warm-up, 4-6 main exercises with sets x
  reps + load from the data, form cues, what to avoid and why. Decisive,
  one plan, no menu. State total duration and what to cut first if time
  runs short.

  WORKOUT CREATION IS ALWAYS TWO PHASES:
  1. DRAFT/REVISION: Write the complete workout in text. Never call
     start_workout_session while proposing or revising. End every complete
     draft with exactly: "{WORKOUT_CONFIRMATION_QUESTION}"
  2. CONFIRMATION: Only after the user explicitly confirms that latest draft,
     call start_workout_session once. Copy every agreed exercise, set, rep,
     weight, set type and note exactly into the tool. Never replace mixed set
     schemes with defaults. If no complete draft is pending, do not call it.

  MULTI-ACTION REQUESTS:
  If one message requests multiple actions, execute every required tool in
  the same turn. Deleting an empty workout and logging its completed
  replacement requires both delete_workout and log_workout. When the user
  says "wie geplant", reconstruct the latest agreed plan, including every
  later correction, and log those exact values.

IN-SESSION (active session exists)
  The user is standing between sets, on a phone. Answer in 1-4 sentences.
  Confirm what was logged, name the next block, stop. No tables, no
  headers, no re-explaining the plan unless asked.

════ LOGGING — accuracy beats completeness ════
- Log ONLY what the user stated. Never infer an unstated warm-up set,
  weight, rep count or RIR. Missing value → ask ONE short question, or
  write the field null. A guessed value is worse than a missing one.
- Input is fragmentary ("6x40, 5x50, war hart"). Parse it, then restate
  what you logged in one compact line so errors surface immediately.
- Ambiguous exercise name → resolve_exercise. If it returns ambiguous,
  ASK. Never guess the movement. A wrong exercise_id silently corrupts
  every future load suggestion for that lift.
- Mark every set warmup or working. Ask if context does not settle it.
- Ask for RIR only after the LAST working set of a MAIN lift, never after
  accessories, never twice in a session. Free-text answers ("war schon
  hart, vielleicht einen noch") map onto the RIR scale.
- Unilateral loads are per side. Dumbbell loads are per dumbbell. State
  the unit when you restate.
- Log prescribed sets alongside actual. If actual deviates far from
  prescribed, say it once, briefly, without lecturing.

════ FACTS ════
- Dates, past loads and history come from USER DATA and tools only. Not
  from conversation context, not from inference. If it is not there, say
  you do not have it.
- History questions ("hab ich X schonmal gemacht", "wieviel letztes Mal",
  "fasse die letzten drei Sessions zusammen") → get_exercise_history or
  get_session_summary. Do not answer them from the context block.
- If the user contradicts logged data, state what is logged in one
  sentence, without arguing. Overwrite only on explicit instruction, via
  correct_log.
- Never claim to remember anything outside the database.

════ CONSTRAINTS & FLAGS ════
- Durable constraints apply to every exercise selection, silently. Do not
  re-explain them each session.
- Open flags: if today's session touches one, ask ONCE whether it is
  still present, then resolve_flag or leave it open.
- Muscle soreness is a training variable: work around it, keep training.
- Joint symptoms are not. Pain or pulling inside a joint, a giving-way
  feeling, or symptoms in daily movement → say plainly it should be
  looked at by a professional. Do not program around undiagnosed joint
  symptoms for more than one session.
- Equipment safety: if the user describes an improvised or unstable
  setup, name the risk once, concretely, and give the safer version.

════ PLAN DRIFT ════
The user reorders, swaps and skips blocks mid-session. That is normal, not
an error. Adapt the remaining blocks and state the consequence in one line
("Schulterdrücken raus → Seitheben auf 4 Sätze"). Do not resend the plan.
If a swap creates a real problem — same muscle twice, main lift after
accessories — say it in one sentence, then adapt anyway.

════ TOOLS ════
- start_workout_session   create the confirm-card only after explicit approval
- log_set                 every set, during the session
- correct_log             fix an earlier entry, on explicit instruction
- get_exercise_history    any question about past loads for one lift
- get_session_summary     any question about past sessions
- resolve_exercise        before logging an unclear exercise name
- open_flag / resolve_flag   a symptom or limitation that changes
                          prescriptions but is not permanent

Do not call save_personal_memory. Durable facts are written after the
session by a separate pass, not by you mid-conversation.

════ STYLE ════
- Never show internal IDs.
- Planning: warm-up, A/B/C…, finisher, duration, what to cut.
- In-session: plain prose, no headers.
- Give one number, not a range, unless the range is the point.

{user_data}"""


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


def run_chat(session: Session, user: User, message: str, active_workout_state: Optional[dict]) -> dict:
    db = crud.get_user_database_state(session, user.id)
    if _client is None and not settings.CLAUDE_API_KEY:
        return {"reply": "AI is not configured (CLAUDE_API_KEY or GEMINI_API_KEY missing).", "actionExecuted": None, "db": db}

    thread_id = str(user.id)

    # 1. Auto-summarize: if recent history has grown past budget, compress older turns.
    history = memory.read_recent_messages(session, user.id, thread_id, limit=20)
    if context.should_summarize("\n".join(m.content for m in history)):
        summ.summarize_conversation(session, user.id, thread_id)
        history = memory.read_recent_messages(session, user.id, thread_id, limit=20)

    can_start_workout = (
        is_explicit_workout_confirmation(message)
        and has_pending_workout_draft(history)
    )
    available_tools = [
        declaration for declaration in TOOL_DECLARATIONS
        if declaration["name"] != "start_workout_session" or can_start_workout
    ]

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

    is_in_session = bool(active_workout_state and active_workout_state.get("exercises"))
    thinking_config = types.ThinkingConfig(
        thinking_level="low" if is_in_session else "medium"
    )

    config = types.GenerateContentConfig(
        system_instruction=system_instruction,
        thinking_config=thinking_config,
        tools=[types.Tool(function_declarations=available_tools)],
    )

    # 4. Multi-step agent loop: the model may call tools, see the results, and keep
    #    reasoning until it returns a final text answer (bounded to avoid runaway).
    action_executed = None
    tools_used: list[str] = []  # debug: every tool invoked this turn
    reply_text = ""
    usage = None
    MAX_STEPS = 4
    def execute_tool(name: str, args: dict, call_id: str = "") -> str:
        nonlocal action_executed
        handler = HANDLERS.get(name)
        if not handler:
            return "unknown tool"

        tools_used.append(name)
        try:
            result = handler(session, user.id, db, args, active_workout_state=active_workout_state)
            memory.write_tool_log(session, user.id, thread_id, name, args, str(result), "success")
            if isinstance(result, dict) and "type" in result:
                action_executed = result

            if name == "start_workout_session":
                return ("The exact confirmed workout is now shown in the confirmation card. "
                        "Tell the user to review the card and press Workout starten.")
            if name == "log_set":
                return (f"Set logged: {args.get('exercise_name')} {args.get('weight')}kg x {args.get('reps')} "
                        f"({args.get('set_type', 'working')}). Confirm to user in 1 compact line and name next block.")
            if name == "correct_log":
                return f"Set corrected: {result.get('data') if isinstance(result, dict) else 'updated'}."
            if name == "open_flag":
                return f"Flag opened: {args.get('note')} ({args.get('flag_type')})."
            if name == "resolve_flag":
                return f"Flag resolved: {args.get('keyword_or_id')}."
            if name == "suggest_weight":
                return f"Suggested weight: {result.get('suggested_weight')}kg ({result.get('reasoning')})."
            return str(result) if result else "done"
        except Exception as error:
            memory.write_tool_log(session, user.id, thread_id, name, args, None, "failed", str(error))
            return f"error: {error}"

    claude_failed = False
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
                handle_tool=execute_tool,
                force_tool_name="start_workout_session" if can_start_workout else None,
                max_steps=MAX_STEPS,
            )
            reply_text = claude_result["text"]
            usage = claude_result["usage"]
        except Exception as error:
            claude_failed = True
            print(f"[coach] Claude failed, trying Gemini fallback: {str(error)[:200]}")

    for _ in range(MAX_STEPS if (not settings.CLAUDE_API_KEY or claude_failed) and _client else 0):
        try:
            response = _generate_with_retry(_client, model=COACH_MODEL, contents=contents, config=config)
            metadata = getattr(response, "usage_metadata", None)
            if metadata:
                input_tokens = getattr(metadata, "prompt_token_count", 0) or 0
                output_tokens = getattr(metadata, "candidates_token_count", 0) or 0
                usage = {
                    "provider": "gemini",
                    "model": COACH_MODEL,
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "cacheCreationTokens": 0,
                    "cacheReadTokens": getattr(metadata, "cached_content_token_count", 0) or 0,
                    "totalTokens": input_tokens + output_tokens,
                    "estimatedCostUsd": 0,
                }
        except Exception as e:
            msg = str(e)
            print(f"[coach] generate_content failed: {msg[:200]}")
            if "503" in msg or "UNAVAILABLE" in msg:
                note = "⚠️ Die Gemini-Server von Google sind gerade kurzzeitig überlastet (503 High Demand). Bitte sende die Nachricht gleich nochmal ab."
            elif "RESOURCE_EXHAUSTED" in msg or "429" in msg:
                note = "⚠️ Die KI ist gerade rate-limited (Gemini Free-Tier). Versuch's in einer Minute nochmal."
            else:
                note = "⚠️ Der AI-Coach hatte einen Fehler. Versuch's nochmal."
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
            feedback = execute_tool(call.name, args, call.id or "")
            contents.append(types.Content(
                role="user",
                parts=[types.Part.from_function_response(
                    name=call.name,
                    response={"result": feedback},
                    id=call.id,
                )],
            ))

    if not reply_text:
        act_type = action_executed.get("type") if isinstance(action_executed, dict) else None
        if act_type in _FALLBACK_REPLIES:
            reply_text = _FALLBACK_REPLIES[act_type](action_executed.get("data"))
        else:
            reply_text = "Wie kann ich dir beim Training helfen?"

    if action_executed and action_executed.get("type") == "workout_proposed":
        reply_text = (
            "Der bestätigte Plan ist jetzt als Workout-Karte vorbereitet. Prüf ihn kurz "
            "und klick auf **Workout starten**."
        )
    elif can_start_workout:
        reply_text = (
            "Ich konnte das Workout-Tool nicht erfolgreich auslösen. Das Workout wurde nicht "
            "gestartet; bitte versuche die Bestätigung erneut."
        )
    elif _claims_workout_started_without_tool(reply_text, action_executed):
        reply_text = (
            f"Das Workout wurde noch nicht gestartet. Ich muss zuerst den vollständigen Plan "
            f"bestätigen lassen: {WORKOUT_CONFIRMATION_QUESTION}"
        )

    # Persist this turn for multi-turn continuity.
    memory.write_message(session, user.id, thread_id, "user", message)
    memory.write_message(session, user.id, thread_id, "assistant", reply_text)

    fresh_db = crud.get_user_database_state(session, user.id)
    return {
        "reply": reply_text,
        "actionExecuted": action_executed,
        "toolsUsed": tools_used,
        "usage": usage,
        "db": fresh_db,
    }


def suggest_weight(session: Session, user: User, exercise_name: str, target_reps: int = 8, target_rpe: int = 8) -> dict:
    """Deterministic arithmetic weight recommendation based on RIR without LLM calls."""
    db = crud.get_user_database_state(session, user.id)
    query = (exercise_name or "").strip().lower()

    last_weight = None
    last_rir = None
    for w in db.get("workouts", []):
        for we in w.get("exercises", []):
            if query in we.get("exerciseName", "").lower():
                completed = [s for s in we.get("sets", []) if s.get("completed")]
                if completed:
                    last_set = completed[-1]
                    last_weight = last_set.get("weight")
                    if last_set.get("rpe") is not None:
                        last_rir = round(10.0 - float(last_set["rpe"]), 1)
                    break
        if last_weight is not None:
            break

    if last_weight is None:
        match = next((e for e in db.get("exercises", []) if e.get("name", "").lower() == query or query in e.get("name", "").lower()), None)
        if match and match.get("personalRecord"):
            pr = match["personalRecord"]
            last_weight = pr.get("maxWeight", 50)
            last_rir = 2.0
        else:
            last_weight = 40.0
            last_rir = None

    is_main = any(term in query for term in ["bank", "bench", "squat", "kniebeuge", "kreuzheben", "deadlift", "drücken", "press", "klimmzug", "pull-up", "rudern", "row"])
    weight, reason = tools.calculate_suggested_weight(float(last_weight), last_rir, is_main_lift=is_main)

    return {
        "suggestedWeight": weight,
        "suggestedReps": target_reps,
        "recommendation": f"{weight}kg ({reason})",
        "reasoning": reason,
    }
