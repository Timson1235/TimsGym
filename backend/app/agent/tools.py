"""The AI coach's tools — function declarations (for Gemini) + Python handlers
(that mutate the DB or query historical performance).

Each handler takes (session, user_id, db_state, args, **kwargs) and returns an
`actionExecuted` dict: {"type": str, "data": Any} (or info dict). `db_state` is
the current camelCase DatabaseState.
"""
import time
from typing import Any, Optional

from sqlmodel import Session

from .. import crud
from .workout_builder import build_workout_proposal


# ---- Arithmetic Weight Suggestion (Zero-LLM) ----

def calculate_suggested_weight(
    last_weight: float,
    last_rir: Optional[float] = None,
    is_main_lift: bool = True,
) -> tuple[float, str]:
    """Pure arithmetic weight recommendation based on RIR and progressive overload.

    Rules:
      - None: hold weight
      - <= 1: hold weight until RIR 2
      - == 2: +2.5% (small step)
      - >= 3: +5% (significantly under-challenged)
    Weights rounded to nearest 2.5kg plate.
    """
    def round_to_plate(w: float, plate: float = 2.5) -> float:
        return round(w / plate) * plate

    if last_rir is None:
        return float(last_weight), "kein RIR — Gewicht halten"
    if last_rir <= 1:
        return float(last_weight), "RIR ≤1 — halten bis RIR 2"
    if last_rir == 2:
        return float(round_to_plate(last_weight * 1.025)), "RIR 2 — kleiner Schritt"
    return float(round_to_plate(last_weight * 1.05)), "RIR 3+ — deutlich unterfordert"


# ---- Gemini function declarations (OpenAPI-style schema dicts) ----

TOOL_DECLARATIONS = [
    {
        "name": "start_workout_session",
        "description": "Create the confirmation card for the latest fully agreed workout. Call only after the user explicitly confirms the text draft.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "title": {"type": "STRING", "description": "Title of the workout session, e.g. 'Push A (Brust/Schulter)'"},
                "sessionNotes": {"type": "STRING", "description": "Optional warm-up, cooldown, and session-wide guidance"},
                "exercises": {
                    "type": "ARRAY",
                    "description": "Every exercise with every set exactly as agreed in the text draft",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "exerciseName": {"type": "STRING", "description": "Exact exercise name from the library when possible"},
                            "notes": {"type": "STRING", "description": "Exercise-specific cues, rest time, or safety note"},
                            "sets": {
                                "type": "ARRAY",
                                "description": "Explicit ordered sets. Expand 3x6 into three separate set objects.",
                                "items": {
                                    "type": "OBJECT",
                                    "properties": {
                                        "weight": {"type": "NUMBER", "description": "Weight in kg; use 0 for bodyweight"},
                                        "reps": {"type": "INTEGER"},
                                        "setType": {"type": "STRING", "enum": ["warmup", "working", "drop", "failure"]},
                                        "rir": {"type": "NUMBER", "description": "Optional planned reps in reserve"},
                                        "notes": {"type": "STRING"},
                                    },
                                    "required": ["weight", "reps", "setType"],
                                },
                            },
                        },
                        "required": ["exerciseName", "sets"],
                    },
                },
            },
            "required": ["title", "exercises"],
        },
    },
    {
        "name": "log_set",
        "description": "Log a single completed set during an active in-session workout. Record ONLY what the user stated; never guess unstated values.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "exercise_name": {"type": "STRING", "description": "Exact name of the exercise"},
                "weight": {"type": "NUMBER", "description": "Weight in kg (per side for unilateral, per dumbbell for dumbbell)"},
                "reps": {"type": "INTEGER", "description": "Repetitions completed"},
                "set_type": {"type": "STRING", "enum": ["working", "warmup", "drop", "failure"], "description": "Type of set ('working' or 'warmup')"},
                "rir": {"type": "NUMBER", "description": "Reps in Reserve (RIR), if stated by user"},
                "notes": {"type": "STRING", "description": "Optional notes on feel or technique"},
            },
            "required": ["exercise_name", "weight", "reps"],
        },
    },
    {
        "name": "correct_log",
        "description": "Fix an earlier logged entry upon explicit instruction from the user. Overwrites the specified set.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "exercise_name": {"type": "STRING", "description": "Name of the exercise to correct"},
                "set_number": {"type": "INTEGER", "description": "Set number to correct (1-indexed), defaults to latest if omitted"},
                "new_weight": {"type": "NUMBER", "description": "Corrected weight"},
                "new_reps": {"type": "INTEGER", "description": "Corrected rep count"},
                "new_set_type": {"type": "STRING", "enum": ["working", "warmup", "drop", "failure"]},
                "new_rir": {"type": "NUMBER", "description": "Corrected RIR"},
            },
            "required": ["exercise_name"],
        },
    },
    {
        "name": "get_exercise_history",
        "description": "Retrieve past logged performance and progression history for a specific exercise from the database.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "exercise_name": {"type": "STRING", "description": "Name of the exercise to look up"},
                "limit": {"type": "INTEGER", "description": "Number of recent sessions to retrieve (default 5)"},
            },
            "required": ["exercise_name"],
        },
    },
    {
        "name": "get_session_summary",
        "description": "Retrieve summaries of past workouts (e.g. to answer 'what did I do in the last 3 sessions?').",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "limit": {"type": "INTEGER", "description": "Number of past workouts to retrieve (default 3)"},
                "search_title_or_date": {"type": "STRING", "description": "Optional title or date filter (YYYY-MM-DD)"},
            },
        },
    },
    {
        "name": "resolve_exercise",
        "description": "Resolve an ambiguous or colloquial exercise name against the user's exercise library before logging.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": {"type": "STRING", "description": "Colloquial or partial exercise name, e.g. 'Bank', 'Schrägbank'"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "open_flag",
        "description": "Open a temporary symptom, limitation, or constraint (e.g. temporary knee soreness after hiking) that alters training prescriptions but is not permanent.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "flag_type": {"type": "STRING", "description": "Type of flag, e.g. 'symptom', 'limitation', 'soreness', 'equipment'"},
                "note": {"type": "STRING", "description": "Specific note describing the symptom or limitation"},
                "date": {"type": "STRING", "description": "Date YYYY-MM-DD (defaults to today)"},
            },
            "required": ["flag_type", "note"],
        },
    },
    {
        "name": "resolve_flag",
        "description": "Resolve and close an open symptom or limitation flag after confirming with the user that it is no longer present.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "keyword_or_id": {"type": "STRING", "description": "Keyword matching the flag note (e.g. 'knie') or flag ID"},
            },
            "required": ["keyword_or_id"],
        },
    },
    {
        "name": "suggest_weight",
        "description": "Calculate progressive overload recommendation for a weight based on last weight and last RIR using deterministic arithmetic.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "last_weight": {"type": "NUMBER", "description": "Last logged weight in kg"},
                "last_rir": {"type": "NUMBER", "description": "Last logged RIR (Reps in Reserve)"},
                "is_main_lift": {"type": "BOOLEAN", "description": "Whether this is a primary compound lift (default True)"},
            },
            "required": ["last_weight"],
        },
    },
    {
        "name": "log_workout",
        "description": "Log a completed workout session directly into the user history log.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "title": {"type": "STRING", "description": "Title of workout session e.g. Push Day"},
                "date": {"type": "STRING", "description": "ISO date YYYY-MM-DD (default to today if unspecified)"},
                "durationMinutes": {"type": "NUMBER", "description": "Duration in minutes"},
                "notes": {"type": "STRING", "description": "Notes or performance highlights"},
                "exercises": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
                    "exerciseName": {"type": "STRING"},
                    "category": {"type": "STRING", "description": "Chest, Back, Legs, Shoulders, Arms, Core, Cardio, or Other"},
                    "sets": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
                        "weight": {"type": "NUMBER"}, "reps": {"type": "NUMBER"},
                        "rpe": {"type": "NUMBER"}, "type": {"type": "STRING"},
                    }, "required": ["weight", "reps"]}},
                }, "required": ["exerciseName", "sets"]}},
            },
            "required": ["title", "exercises"],
        },
    },
    {
        "name": "add_exercise",
        "description": "Add a new movement to the exercise library.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "name": {"type": "STRING"}, "category": {"type": "STRING"},
                "equipment": {"type": "STRING"}, "instructions": {"type": "STRING"},
            },
            "required": ["name", "category", "equipment"],
        },
    },
    {
        "name": "update_profile",
        "description": "Update user profile goals or experience level.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "name": {"type": "STRING"},
                "primaryGoal": {"type": "STRING", "description": "Strength, Hypertrophy, Endurance, General Fitness, Weight Loss, or Athleticism & Jump Power"},
                "experienceLevel": {"type": "STRING", "description": "Beginner, Intermediate, or Advanced"},
            },
        },
    },
    {
        "name": "delete_workout",
        "description": "Delete a workout session from history by workout ID or title.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "searchOrId": {"type": "STRING", "description": "Workout ID or title match string"},
            },
            "required": ["searchOrId"],
        },
    },
]


# ---- Handlers ----

def _now_id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000)}"


def handle_start_workout_session(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    return {"type": "workout_proposed", "data": build_workout_proposal(db, args)}


def handle_log_set(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    active_workout_state = kwargs.get("active_workout_state")
    ex_name = (args.get("exercise_name") or "Exercise").strip()
    weight = float(args.get("weight", 0))
    reps = int(args.get("reps", 0))
    set_type = args.get("set_type", "working")
    rir = args.get("rir")
    notes = args.get("notes")
    rpe = round(10.0 - float(rir), 1) if rir is not None else None

    logged_data = {
        "exerciseName": ex_name,
        "weight": weight,
        "reps": reps,
        "setType": set_type,
        "rir": rir,
        "rpe": rpe,
        "notes": notes,
    }

    if active_workout_state and isinstance(active_workout_state.get("exercises"), list):
        we = next((e for e in active_workout_state["exercises"]
                   if e.get("exerciseName", "").lower() == ex_name.lower()), None)
        if not we:
            match = next((e for e in db["exercises"] if e["name"].lower() == ex_name.lower()), None)
            we = {
                "id": _now_id("we"),
                "exerciseId": match["id"] if match else f"ex_live_{int(time.time()*1000)}",
                "exerciseName": match["name"] if match else ex_name,
                "category": match["category"] if match else "Other",
                "sets": [],
            }
            active_workout_state["exercises"].append(we)

        # Look for the first uncompleted set or append new
        pending = next((s for s in we.get("sets", []) if not s.get("completed")), None)
        if pending:
            pending["weight"] = weight
            pending["reps"] = reps
            pending["type"] = set_type
            pending["completed"] = True
            if rpe is not None:
                pending["rpe"] = rpe
            if notes:
                pending["notes"] = notes
        else:
            new_s = {
                "id": _now_id("s"),
                "setNumber": len(we.get("sets", [])) + 1,
                "type": set_type,
                "weight": weight,
                "reps": reps,
                "rpe": rpe or 8,
                "completed": True,
                "notes": notes,
            }
            we.setdefault("sets", []).append(new_s)

    return {"type": "set_logged", "data": logged_data}


def handle_correct_log(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    active_workout_state = kwargs.get("active_workout_state")
    ex_name = (args.get("exercise_name") or "").strip()
    set_num = args.get("set_number")
    new_w = args.get("new_weight")
    new_r = args.get("new_reps")
    new_type = args.get("new_set_type")
    new_rir = args.get("new_rir")

    corrected = False
    if active_workout_state and isinstance(active_workout_state.get("exercises"), list):
        for we in active_workout_state["exercises"]:
            if we.get("exerciseName", "").lower() == ex_name.lower():
                sets = we.get("sets", [])
                target_set = None
                if set_num is not None and 1 <= set_num <= len(sets):
                    target_set = sets[set_num - 1]
                elif sets:
                    target_set = sets[-1]

                if target_set:
                    if new_w is not None:
                        target_set["weight"] = float(new_w)
                    if new_r is not None:
                        target_set["reps"] = int(new_r)
                    if new_type is not None:
                        target_set["type"] = new_type
                    if new_rir is not None:
                        target_set["rpe"] = round(10.0 - float(new_rir), 1)
                    corrected = True
                    break

    return {
        "type": "log_corrected",
        "data": {
            "exerciseName": ex_name,
            "setNumber": set_num,
            "weight": new_w,
            "reps": new_r,
            "rir": new_rir,
            "status": "updated" if corrected else "not_found_in_active_session",
        },
    }


def handle_get_exercise_history(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    query = (args.get("exercise_name") or "").strip().lower()
    limit = int(args.get("limit", 5))

    match = next((e for e in db["exercises"] if e["name"].lower() == query or query in e["name"].lower()), None)
    pr_info = (match.get("personalRecord") if match else None) or {}

    history_entries = []
    for w in db.get("workouts", []):
        for we in w.get("exercises", []):
            if query in we.get("exerciseName", "").lower():
                completed_sets = [
                    f"{s.get('weight')}x{s.get('reps')}" + (f" (RIR {round(10-s['rpe'], 1)})" if s.get('rpe') else "")
                    for s in we.get("sets", []) if s.get("completed")
                ]
                if completed_sets:
                    history_entries.append({
                        "date": w.get("date"),
                        "workoutTitle": w.get("title"),
                        "sets": ", ".join(completed_sets),
                    })
                if len(history_entries) >= limit:
                    break
        if len(history_entries) >= limit:
            break

    return {
        "exercise": match["name"] if match else query,
        "pr": pr_info,
        "history": history_entries,
    }


def handle_get_session_summary(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    limit = int(args.get("limit", 3))
    query = (args.get("search_title_or_date") or "").strip().lower()

    summaries = []
    for w in db.get("workouts", []):
        if query and (query not in w.get("title", "").lower() and query not in w.get("date", "")):
            continue
        ex_summaries = []
        for we in w.get("exercises", []):
            sets_str = ", ".join(f"{s.get('weight')}x{s.get('reps')}" for s in we.get("sets", []) if s.get("completed"))
            if sets_str:
                ex_summaries.append(f"{we.get('exerciseName')}: {sets_str}")
        summaries.append({
            "id": w.get("id"),
            "date": w.get("date"),
            "title": w.get("title"),
            "totalVolume": w.get("totalVolume"),
            "exercises": ex_summaries,
            "notes": w.get("notes"),
        })
        if len(summaries) >= limit:
            break

    return {"sessions": summaries}


def handle_resolve_exercise(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    query = (args.get("query") or "").strip().lower()
    matches = [e for e in db.get("exercises", []) if query in e["name"].lower()]

    exact = next((e for e in matches if e["name"].lower() == query), None)
    if exact:
        return {"status": "exact_match", "exerciseName": exact["name"], "id": exact["id"], "category": exact["category"]}
    if len(matches) == 1:
        return {"status": "exact_match", "exerciseName": matches[0]["name"], "id": matches[0]["id"], "category": matches[0]["category"]}
    if len(matches) > 1:
        return {"status": "ambiguous", "candidates": [m["name"] for m in matches[:5]], "message": "Multiple matches found. Clarify with user."}
    return {"status": "not_found", "query": query, "message": "No matching exercise found."}


def handle_open_flag(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    flag_type = args.get("flag_type", "symptom")
    note = args.get("note", "").strip()
    date = args.get("date") or time.strftime("%Y-%m-%d")

    profile = db.get("profile", {})
    flags = list(profile.get("openFlags") or [])
    new_flag = {"id": _now_id("flg"), "type": flag_type, "note": note, "date": date}
    flags.append(new_flag)
    profile["openFlags"] = flags
    crud.update_user_profile(session, user_id, {"openFlags": flags})
    return {"type": "flag_opened", "data": new_flag}


def handle_resolve_flag(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    query = (args.get("keyword_or_id") or "").strip().lower()
    profile = db.get("profile", {})
    flags = list(profile.get("openFlags") or [])
    remaining = [f for f in flags if f.get("id") != query and query not in f.get("note", "").lower()]
    resolved_count = len(flags) - len(remaining)
    profile["openFlags"] = remaining
    crud.update_user_profile(session, user_id, {"openFlags": remaining})
    return {"type": "flag_resolved", "data": {"query": query, "resolvedCount": resolved_count}}


def handle_suggest_weight(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    last_w = float(args.get("last_weight", 0))
    last_rir = args.get("last_rir")
    if last_rir is not None:
        last_rir = float(last_rir)
    is_main = bool(args.get("is_main_lift", True))
    weight, reason = calculate_suggested_weight(last_w, last_rir, is_main)
    return {"suggested_weight": weight, "reasoning": reason}


def handle_save_personal_memory(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    memory = (args.get("memory") or "").strip()
    memories = list(db["profile"].get("personalMemories") or [])
    if memory and memory not in memories:
        memories.append(memory)
    db["profile"]["personalMemories"] = memories
    crud.update_user_profile(session, user_id, {"personalMemories": memories})
    return {"type": "memory_saved", "data": memory}


def handle_remove_personal_memory(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    query = (args.get("memoryTextOrIndex") or "").lower()
    memories = [m for m in (db["profile"].get("personalMemories") or []) if query not in m.lower()]
    db["profile"]["personalMemories"] = memories
    crud.update_user_profile(session, user_id, {"personalMemories": memories})
    return {"type": "memory_removed", "data": args.get("memoryTextOrIndex")}


def handle_log_workout(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    today = time.strftime("%Y-%m-%d")
    exercises_out = []
    total_volume = 0
    for ex_idx, ex_item in enumerate(args.get("exercises", [])):
        match = next((e for e in db["exercises"] if e["name"].lower() == (ex_item.get("exerciseName") or "").lower()), None)
        sets = []
        for s_idx, s in enumerate(ex_item.get("sets", [])):
            w, r = s.get("weight", 0) or 0, s.get("reps", 0) or 0
            total_volume += w * r
            sets.append({"id": f"s_{int(time.time()*1000)}_{ex_idx}_{s_idx}", "setNumber": s_idx + 1,
                         "type": s.get("type", "working"), "weight": w, "reps": r,
                         "rpe": s.get("rpe", 8), "completed": True})
        exercises_out.append({"id": f"we_{int(time.time()*1000)}_{ex_idx}",
                              "exerciseId": match["id"] if match else f"ex_dyn_{int(time.time()*1000)}_{ex_idx}",
                              "exerciseName": ex_item.get("exerciseName", "Custom Movement"),
                              "category": ex_item.get("category") or (match["category"] if match else "Chest"),
                              "sets": sets})
    new_workout = {
        "id": _now_id("wk"), "title": args.get("title", "Logged Session"),
        "date": args.get("date") or today, "durationMinutes": args.get("durationMinutes", 45),
        "totalVolume": total_volume, "isCompleted": True,
        "notes": args.get("notes", "Logged via GymPulse AI Coach"), "exercises": exercises_out,
    }
    crud.save_user_workout(session, user_id, new_workout)
    crud.update_personal_records(session, user_id, new_workout)
    db["workouts"].insert(0, new_workout)
    return {"type": "workout_logged", "data": new_workout}


def handle_add_exercise(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    new_ex = {"id": _now_id("ex"), "name": args.get("name"),
              "category": args.get("category", "Chest"), "equipment": args.get("equipment", "Barbell"),
              "instructions": args.get("instructions", "Added via GymPulse AI Coach"), "isCustom": True}
    crud.save_user_exercise(session, user_id, new_ex)
    db["exercises"].append(new_ex)
    return {"type": "exercise_added", "data": new_ex}


def handle_update_profile(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    if args.get("name"):
        db["profile"]["name"] = args["name"]
    if args.get("primaryGoal"):
        db["profile"]["primaryGoal"] = args["primaryGoal"]
    if args.get("experienceLevel"):
        db["profile"]["experienceLevel"] = args["experienceLevel"]
    db["profile"]["preferredUnit"] = "kg"
    crud.update_user_profile(session, user_id, db["profile"])
    return {"type": "profile_updated", "data": db["profile"]}


def handle_delete_workout(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> Optional[dict]:
    search = (args.get("searchOrId") or "").lower()
    target = next((w for w in db["workouts"] if w["id"] == search or search in w["title"].lower()), None)
    if not target:
        return None
    crud.delete_user_workout(session, user_id, target["id"])
    db["workouts"] = [w for w in db["workouts"] if w["id"] != target["id"]]
    return {"type": "workout_deleted", "data": target}


HANDLERS = {
    "start_workout_session": handle_start_workout_session,
    "log_set": handle_log_set,
    "correct_log": handle_correct_log,
    "get_exercise_history": handle_get_exercise_history,
    "get_session_summary": handle_get_session_summary,
    "resolve_exercise": handle_resolve_exercise,
    "open_flag": handle_open_flag,
    "resolve_flag": handle_resolve_flag,
    "suggest_weight": handle_suggest_weight,
    "log_workout": handle_log_workout,
    "add_exercise": handle_add_exercise,
    "update_profile": handle_update_profile,
    "delete_workout": handle_delete_workout,
    "save_personal_memory": handle_save_personal_memory,
    "remove_personal_memory": handle_remove_personal_memory,
}
