"""The AI coach's tools — function declarations (for Gemini) + Python handlers
(that mutate the DB). Ported from the function-calling block in server.ts.

Each handler takes (session, user_id, db_state, args) and returns an
`actionExecuted` dict: {"type": str, "data": Any}. `db_state` is the current
camelCase DatabaseState (mutated in place so the reply reflects the change);
persistence goes through crud into Neon.
"""
import time
from typing import Any, Optional

from sqlmodel import Session

from .. import crud

# ---- Gemini function declarations (OpenAPI-style schema dicts) ----

TOOL_DECLARATIONS = [
    {
        "name": "save_personal_memory",
        "description": 'Save or remember a personal fitness goal (e.g. "Gewicht verlieren", "Muskeln aufbauen", "Sprungkraft verbessern"), injury constraint, sport preference, or personal note permanently into user memory.',
        "parameters": {"type": "OBJECT", "properties": {
            "memory": {"type": "STRING", "description": "The personal goal, preference, constraint, or fact to remember."}
        }, "required": ["memory"]},
    },
    {
        "name": "remove_personal_memory",
        "description": "Remove or forget a specific personal goal or memory from the user profile.",
        "parameters": {"type": "OBJECT", "properties": {
            "memoryTextOrIndex": {"type": "STRING", "description": "The memory text or keyword to remove."}
        }, "required": ["memoryTextOrIndex"]},
    },
    {
        "name": "log_workout",
        "description": "Log a new completed workout session directly into the user history log.",
        "parameters": {"type": "OBJECT", "properties": {
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
        }, "required": ["title", "exercises"]},
    },
    {
        "name": "add_exercise",
        "description": "Add a new movement to the exercise library.",
        "parameters": {"type": "OBJECT", "properties": {
            "name": {"type": "STRING"}, "category": {"type": "STRING"},
            "equipment": {"type": "STRING"}, "instructions": {"type": "STRING"},
        }, "required": ["name", "category", "equipment"]},
    },
    {
        "name": "update_profile",
        "description": "Update user profile goals or experience level.",
        "parameters": {"type": "OBJECT", "properties": {
            "name": {"type": "STRING"},
            "primaryGoal": {"type": "STRING", "description": "Strength, Hypertrophy, Endurance, General Fitness, Weight Loss, or Athleticism & Jump Power"},
            "experienceLevel": {"type": "STRING", "description": "Beginner, Intermediate, or Advanced"},
        }},
    },
    {
        "name": "delete_workout",
        "description": "Delete a workout session from history by workout ID or title.",
        "parameters": {"type": "OBJECT", "properties": {
            "searchOrId": {"type": "STRING", "description": "Workout ID or title match string"}
        }, "required": ["searchOrId"]},
    },
    {
        "name": "start_workout_session",
        "description": "Start or pre-load an active workout session.",
        "parameters": {"type": "OBJECT", "properties": {
            "title": {"type": "STRING"},
            "exerciseNames": {"type": "ARRAY", "items": {"type": "STRING"}, "description": "List of exercise names to pre-load"},
        }, "required": ["title", "exerciseNames"]},
    },
]


# ---- handlers ----

def _now_id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000)}"


def handle_save_personal_memory(session: Session, user_id: int, db: dict, args: dict) -> dict:
    memory = (args.get("memory") or "").strip()
    memories = list(db["profile"].get("personalMemories") or [])
    if memory and memory not in memories:
        memories.append(memory)
    db["profile"]["personalMemories"] = memories
    crud.update_user_profile(session, user_id, {"personalMemories": memories})
    return {"type": "memory_saved", "data": memory}


def handle_remove_personal_memory(session: Session, user_id: int, db: dict, args: dict) -> dict:
    query = (args.get("memoryTextOrIndex") or "").lower()
    memories = [m for m in (db["profile"].get("personalMemories") or []) if query not in m.lower()]
    db["profile"]["personalMemories"] = memories
    crud.update_user_profile(session, user_id, {"personalMemories": memories})
    return {"type": "memory_removed", "data": args.get("memoryTextOrIndex")}


def handle_log_workout(session: Session, user_id: int, db: dict, args: dict) -> dict:
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


def handle_add_exercise(session: Session, user_id: int, db: dict, args: dict) -> dict:
    new_ex = {"id": _now_id("ex"), "name": args.get("name"),
              "category": args.get("category", "Chest"), "equipment": args.get("equipment", "Barbell"),
              "instructions": args.get("instructions", "Added via GymPulse AI Coach"), "isCustom": True}
    crud.save_user_exercise(session, user_id, new_ex)
    db["exercises"].append(new_ex)
    return {"type": "exercise_added", "data": new_ex}


def handle_update_profile(session: Session, user_id: int, db: dict, args: dict) -> dict:
    if args.get("name"):
        db["profile"]["name"] = args["name"]
    if args.get("primaryGoal"):
        db["profile"]["primaryGoal"] = args["primaryGoal"]
    if args.get("experienceLevel"):
        db["profile"]["experienceLevel"] = args["experienceLevel"]
    db["profile"]["preferredUnit"] = "kg"
    crud.update_user_profile(session, user_id, db["profile"])
    return {"type": "profile_updated", "data": db["profile"]}


def handle_delete_workout(session: Session, user_id: int, db: dict, args: dict) -> Optional[dict]:
    search = (args.get("searchOrId") or "").lower()
    target = next((w for w in db["workouts"] if w["id"] == search or search in w["title"].lower()), None)
    if not target:
        return None
    crud.delete_user_workout(session, user_id, target["id"])
    db["workouts"] = [w for w in db["workouts"] if w["id"] != target["id"]]
    return {"type": "workout_deleted", "data": target}


def handle_start_workout_session(session: Session, user_id: int, db: dict, args: dict) -> dict:
    session_exercises = []
    for idx, name in enumerate(args.get("exerciseNames", [])):
        match = next((e for e in db["exercises"] if e["name"].lower() == name.lower()), None)
        default_w = (match.get("personalRecord", {}) or {}).get("maxWeight", 60) if match else 60
        session_exercises.append({
            "id": f"we_{int(time.time()*1000)}_{idx}",
            "exerciseId": match["id"] if match else f"ex_temp_{idx}",
            "exerciseName": match["name"] if match else name,
            "category": match["category"] if match else "Chest",
            "sets": [{"id": f"s_{int(time.time()*1000)}_{idx}_{n}", "setNumber": n, "type": "working",
                      "weight": default_w, "reps": 10, "rpe": 8, "completed": False} for n in (1, 2, 3)],
        })
    new_session = {"id": _now_id("wk"), "title": args.get("title", "AI Initiated Session"),
                   "date": time.strftime("%Y-%m-%d"), "durationMinutes": 0, "totalVolume": 0,
                   "isCompleted": False, "exercises": session_exercises}
    # PROPOSAL only — the frontend shows this with a confirm button; it does NOT
    # auto-start. The workout begins when the user clicks "start".
    return {"type": "workout_proposed", "data": new_session}


HANDLERS = {
    "save_personal_memory": handle_save_personal_memory,
    "remove_personal_memory": handle_remove_personal_memory,
    "log_workout": handle_log_workout,
    "add_exercise": handle_add_exercise,
    "update_profile": handle_update_profile,
    "delete_workout": handle_delete_workout,
    "start_workout_session": handle_start_workout_session,
}
