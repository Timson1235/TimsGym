"""Data-access layer — the Python port of src/db/users.ts + the PR logic from
server.ts. Returns camelCase dicts matching the React frontend's DatabaseState.
"""
from typing import Any, Optional

from sqlmodel import Session, select

from .models import Exercise, Profile, User, Workout
from .seed import DEFAULT_MEMORIES, DEFAULT_SEED_EXERCISES, DEFAULT_TEMPLATES


# ---------- serialization (DB row -> API camelCase) ----------

def _exercise_out(ex: Exercise) -> dict:
    out = {
        "id": ex.id,
        "name": ex.name,
        "category": ex.category,
        "equipment": ex.equipment,
        "isCustom": ex.is_custom or False,
    }
    if ex.instructions:
        out["instructions"] = ex.instructions
    if ex.personal_record:
        out["personalRecord"] = ex.personal_record
    return out


def _profile_out(p: Optional[Profile]) -> dict:
    if not p:
        return {
            "name": "Athlete", "preferredUnit": "kg", "experienceLevel": "Intermediate",
            "primaryGoal": "Hypertrophy", "personalMemories": [DEFAULT_MEMORIES[0]],
        }
    return {
        "name": p.name,
        "preferredUnit": p.preferred_unit or "kg",
        "experienceLevel": p.experience_level or "Intermediate",
        "primaryGoal": p.primary_goal or "Hypertrophy",
        "personalMemories": p.personal_memories if isinstance(p.personal_memories, list) else [],
        "notes": p.notes or None,
    }


def _workout_out(w: Workout) -> dict:
    return {
        "id": w.id,
        "title": w.title,
        "date": w.date,
        "durationMinutes": w.duration_minutes,
        "totalVolume": w.total_volume,
        "isCompleted": w.is_completed if w.is_completed is not None else True,
        "notes": w.notes or None,
        "exercises": w.exercises_data or [],
    }


# ---------- user bootstrap ----------

def get_or_create_user(session: Session, uid: str, email: str, display_name: Optional[str] = None) -> User:
    user = session.exec(select(User).where(User.uid == uid)).first()
    if user is None:
        user = User(uid=uid, email=email)
        session.add(user)
    else:
        user.email = email
        session.add(user)
    session.commit()
    session.refresh(user)

    # Ensure a default profile exists.
    profile = session.exec(select(Profile).where(Profile.user_id == user.id)).first()
    if profile is None:
        initial_name = (display_name or (email.split("@")[0] if email else "") or "Athlete")
        session.add(Profile(
            user_id=user.id, name=initial_name, preferred_unit="kg",
            experience_level="Intermediate", primary_goal="Hypertrophy",
            personal_memories=list(DEFAULT_MEMORIES), notes="",
        ))
        session.commit()

    # Ensure the seed exercise library exists for this user.
    has_exercise = session.exec(select(Exercise).where(Exercise.user_id == user.id)).first()
    if has_exercise is None:
        for ex in DEFAULT_SEED_EXERCISES:
            session.add(Exercise(
                id=f"{ex['id']}_{user.id}", user_id=user.id, name=ex["name"],
                category=ex["category"], equipment=ex["equipment"],
                instructions=ex.get("instructions"), is_custom=False, personal_record=None,
            ))
        session.commit()

    return user


# ---------- read full state ----------

def get_user_database_state(session: Session, user_id: int) -> dict:
    profile = session.exec(select(Profile).where(Profile.user_id == user_id)).first()

    exercise_rows = session.exec(select(Exercise).where(Exercise.user_id == user_id)).all()
    exercises_out = [_exercise_out(e) for e in exercise_rows]
    if not exercises_out:
        exercises_out = [
            {**{k: v for k, v in e.items() if k != "id"}, "id": f"{e['id']}_{user_id}", "isCustom": False}
            for e in DEFAULT_SEED_EXERCISES
        ]

    workout_rows = session.exec(select(Workout).where(Workout.user_id == user_id)).all()
    workouts_out = [_workout_out(w) for w in workout_rows]

    # Remap template exercise IDs to this user's exercise IDs (match by name).
    seed_by_id = {e["id"]: e for e in DEFAULT_SEED_EXERCISES}
    name_to_id = {e["name"].lower(): e["id"] for e in exercises_out}
    templates_out = []
    for tpl in DEFAULT_TEMPLATES:
        remapped = []
        for item in tpl["exercises"]:
            seed = seed_by_id.get(item["exerciseId"])
            uid_ex = name_to_id.get(seed["name"].lower()) if seed else None
            remapped.append({**item, "exerciseId": uid_ex or item["exerciseId"]})
        templates_out.append({**tpl, "exercises": remapped})

    return {
        "profile": _profile_out(profile),
        "exercises": exercises_out,
        "workouts": workouts_out,
        "templates": templates_out,
    }


# ---------- writes ----------

def update_user_profile(session: Session, user_id: int, partial: dict) -> None:
    profile = session.exec(select(Profile).where(Profile.user_id == user_id)).first()
    if profile is None:
        profile = Profile(user_id=user_id)
        session.add(profile)
    mapping = {
        "name": "name", "preferredUnit": "preferred_unit", "experienceLevel": "experience_level",
        "primaryGoal": "primary_goal", "personalMemories": "personal_memories", "notes": "notes",
    }
    for api_key, col in mapping.items():
        if api_key in partial and partial[api_key] is not None:
            setattr(profile, col, partial[api_key])
    session.add(profile)
    session.commit()


def save_user_exercise(session: Session, user_id: int, ex: dict) -> None:
    existing = session.get(Exercise, ex["id"])
    if existing is None:
        existing = Exercise(id=ex["id"], user_id=user_id, name=ex["name"],
                            category=ex["category"], equipment=ex["equipment"])
        session.add(existing)
    existing.name = ex["name"]
    existing.category = ex["category"]
    existing.equipment = ex["equipment"]
    existing.instructions = ex.get("instructions")
    existing.is_custom = ex.get("isCustom", False)
    existing.personal_record = ex.get("personalRecord")
    session.add(existing)
    session.commit()


def save_user_workout(session: Session, user_id: int, w: dict) -> None:
    existing = session.get(Workout, w["id"])
    if existing is None:
        existing = Workout(id=w["id"], user_id=user_id, title=w.get("title", "Workout"), date=w.get("date", ""))
        session.add(existing)
    existing.title = w.get("title", "Workout")
    existing.date = w.get("date", "")
    existing.duration_minutes = w.get("durationMinutes", 0)
    existing.total_volume = w.get("totalVolume", 0)
    existing.is_completed = w.get("isCompleted", True)
    existing.notes = w.get("notes")
    existing.exercises_data = w.get("exercises", [])
    session.add(existing)
    session.commit()


def delete_user_workout(session: Session, user_id: int, workout_id: str) -> None:
    w = session.get(Workout, workout_id)
    if w is not None and w.user_id == user_id:
        session.delete(w)
        session.commit()


def reset_user(session: Session, user_id: int) -> None:
    """Wipe the user's workouts and clear PRs (a fresh start in the cloud)."""
    for w in session.exec(select(Workout).where(Workout.user_id == user_id)).all():
        session.delete(w)
    for ex in session.exec(select(Exercise).where(Exercise.user_id == user_id)).all():
        ex.personal_record = None
        session.add(ex)
    profile = session.exec(select(Profile).where(Profile.user_id == user_id)).first()
    if profile is not None:
        profile.personal_memories = list(DEFAULT_MEMORIES)
        session.add(profile)
    session.commit()


def update_personal_records(session: Session, user_id: int, workout: dict) -> None:
    """Recompute PRs after a workout save (Epley 1RM = weight * (1 + reps/30))."""
    for we in workout.get("exercises", []):
        ex = session.get(Exercise, we.get("exerciseId"))
        if ex is None or ex.user_id != user_id:
            continue
        pr = ex.personal_record or {}
        highest_1rm = pr.get("calculatedOneRepMax", 0)
        best_w, best_r = pr.get("maxWeight", 0), pr.get("maxReps", 0)
        updated = False
        for s in we.get("sets", []):
            if s.get("completed") and (s.get("weight", 0) > 0) and (s.get("reps", 0) > 0):
                est = round(s["weight"] * (1 + s["reps"] / 30))
                if est > highest_1rm:
                    highest_1rm, best_w, best_r, updated = est, s["weight"], s["reps"], True
        if updated:
            ex.personal_record = {
                "maxWeight": best_w, "maxReps": best_r,
                "calculatedOneRepMax": highest_1rm,
                "date": workout.get("date"),
            }
            session.add(ex)
    session.commit()
