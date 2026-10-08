import time

from .exercise_identity import resolve_exercise


def build_workout_proposal(db: dict, args: dict, timestamp: int | None = None) -> dict:
    planned_exercises = args.get("exercises") or []
    if not planned_exercises:
        raise ValueError("A confirmed workout requires at least one exercise")

    timestamp = timestamp or int(time.time() * 1000)
    session_exercises = []
    for exercise_index, planned in enumerate(planned_exercises):
        name = (planned.get("exerciseName") or "").strip()
        planned_sets = planned.get("sets") or []
        if not name or not planned_sets:
            raise ValueError("Every workout exercise requires a name and explicit sets")

        match, candidates = resolve_exercise(db["exercises"], name)
        if not match:
            detail = ", ".join(item["name"] for item in candidates[:5]) if candidates else "no library match"
            raise ValueError(f'Exercise "{name}" is not canonical ({detail})')
        workout_sets = []
        for set_index, planned_set in enumerate(planned_sets, start=1):
            rir = planned_set.get("rir")
            workout_sets.append({
                "id": f"s_{timestamp}_{exercise_index}_{set_index}",
                "setNumber": set_index,
                "type": planned_set.get("setType", "working"),
                "weight": float(planned_set["weight"]),
                "reps": int(planned_set["reps"]),
                "rpe": round(10.0 - float(rir), 1) if rir is not None else None,
                "completed": False,
                "notes": planned_set.get("notes"),
            })

        session_exercises.append({
            "id": f"we_{timestamp}_{exercise_index}",
            "exerciseId": match["id"],
            "exerciseName": match["name"],
            "category": match["category"],
            "sets": workout_sets,
            "notes": planned.get("notes"),
        })

    return {
        "id": f"wk_{timestamp}",
        "title": args.get("title", "AI Initiated Session"),
        "date": time.strftime("%Y-%m-%d"),
        "durationMinutes": 0,
        "totalVolume": 0,
        "isCompleted": False,
        "exercises": session_exercises,
        "notes": args.get("sessionNotes"),
    }
