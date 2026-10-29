"""The AI coach's tools — function declarations (for Gemini) + Python handlers
(that mutate the DB or query historical performance).

Each handler takes (session, user_id, db_state, args, **kwargs) and returns an
`actionExecuted` dict: {"type": str, "data": Any} (or info dict). `db_state` is
the current camelCase DatabaseState.
"""
import time
import base64
import json
from copy import deepcopy
from typing import Any, Optional

from sqlmodel import Session

from .. import crud
from .exercise_identity import ALIASES, normalize_exercise_name, resolve_exercise
from .workout_builder import build_workout_proposal
from .progression import recommend_progression


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
        "name": "save_personal_memory",
        "description": "Persist a durable fitness preference, goal, constraint, injury note, or personal fact. Call this whenever the user explicitly asks to remember, save, or add something to memory. Store only the concise fact, not the surrounding command.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "memory": {
                    "type": "STRING",
                    "description": "Concise durable fact to remember, e.g. 'Prefers compound exercises'.",
                },
            },
            "required": ["memory"],
        },
    },
    {
        "name": "remove_personal_memory",
        "description": "Remove a saved personal memory when the user explicitly asks to forget or delete it.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "memoryTextOrIndex": {
                    "type": "STRING",
                    "description": "Distinctive text or keyword identifying the memory to remove.",
                },
            },
            "required": ["memoryTextOrIndex"],
        },
    },
    {
        "name": "start_workout_session",
        "description": "Show a preview/start button for a complete proposed workout in the same turn as the proposal or revision. Do not wait for a separate chat confirmation. Calling this tool never starts a session: the user explicitly starts it by clicking the start button. General training advice without a complete workout does not require this tool. Preserve every proposed exercise, set, rep, weight, set type and note. Calling it again replaces the previous proposal, retaining all later agreed corrections. Existing exercises use canonical identities; missing exercises are persisted by this tool. Clarify ambiguous identities first.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "title": {"type": "STRING", "description": "Title of the workout session, e.g. 'Full body A'"},
                "sessionNotes": {"type": "STRING", "description": "Optional warm-up, cooldown, and session-wide guidance"},
                "exercises": {
                    "type": "ARRAY",
                    "description": "Every exercise/set exactly as prescribed. Include progression settings for new/revised exercises: rep range, target RIR, normally 2 required sessions, and only a known available increment. Skill goals use strategy=skill with measurable criteria; never automatically change variations.",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "exerciseName": {"type": "STRING", "description": "Canonical exercise name. Resolve unfamiliar aliases first; ambiguous results require clarification."},
                            "category": {"type": "STRING", "description": "Optional muscle or movement category for a new exercise, e.g. Plyometrics"},
                            "equipment": {"type": "STRING", "description": "Optional equipment, e.g. Bodyweight, Barbell, Dumbbell, Cable, Machine, or Other"},
                            "notes": {"type": "STRING", "description": "Exercise-specific cues, rest time, or safety note"},
                            "progression": {
                                "type": "OBJECT", "description": "Structured progression prescription. Specify a rep range and target RIR, and only a known available weight increment. Skill goals use measurable criteria for the current variation.",
                                "properties": {
                                    "version": {"type":"INTEGER", "description":"Schema version, always 1"},
                                    "strategy": {"type":"STRING", "enum":["double_progression","skill"]},
                                    "repMin": {"type":"INTEGER"}, "repMax": {"type":"INTEGER"},
                                    "targetRir": {"type":"NUMBER"}, "weightIncrement": {"type":"NUMBER"},
                                    "requiredSessions": {"type":"INTEGER", "description":"Comparable successful sessions before a weight/variation change; default 2."},
                                    "goal": {"type":"OBJECT", "properties": {
                                        "targetMovement":{"type":"STRING"}, "currentVariation":{"type":"STRING"},
                                        "targetSets":{"type":"INTEGER"}, "targetReps":{"type":"INTEGER"}},
                                        "required":["targetMovement","currentVariation","targetSets","targetReps"]},
                                }, "required":["strategy","repMin","repMax","targetRir"],
                            },
                            "sets": {
                                "type": "ARRAY",
                                "description": "Explicit ordered sets. Expand 3x6 into three separate set objects.",
                                "items": {
                                    "type": "OBJECT",
                                    "properties": {
                                        "weight": {"type": "NUMBER", "description": "Weight in kg; use 0 for bodyweight"},
                                        "reps": {"type": "INTEGER"},
                                        "setType": {"type": "STRING", "enum": ["warmup", "working", "drop", "failure"]},
                                        "rir": {"type": "NUMBER", "description": "Optional PLANNED reps in reserve, not achieved effort"},
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
        "description": "Log a single completed set during an active in-session workout. Record ONLY what the user stated; never guess unstated values or effort. Resolve unclear names first. For not_found, discover add_exercise, add once and retry; ambiguous matches require clarification. Loads are per dumbbell/per side where applicable; confirm the unit.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "exercise_name": {"type": "STRING", "description": "Exact name of the exercise"},
                "weight": {"type": "NUMBER", "description": "Weight in kg (per side for unilateral, per dumbbell for dumbbell)"},
                "reps": {"type": "INTEGER", "description": "Repetitions completed"},
                "set_type": {"type": "STRING", "enum": ["working", "warmup", "drop", "failure"], "description": "Explicit set role; clarify if uncertain"},
                "rir": {"type": "NUMBER", "description": "Reps in Reserve (RIR), if stated by user"},
                "notes": {"type": "STRING", "description": "Optional notes on feel or technique"},
            },
            "required": ["exercise_name", "weight", "reps"],
        },
    },
    {
        "name": "correct_log",
        "description": "Fix an earlier logged entry upon explicit instruction from the user. Requires an active workout. Overwrites the specified set only on explicit instruction. Resolve an unclear exercise name first.",
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
        "description": "Retrieve a single exercise across completed workouts, newest first, independently of which workout contains it. Use limit=1 for its last performance or 3-5 for progression. Prefer exercise_id; names use canonical alias resolution and never guess ambiguous matches.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "exercise_name": {"type": "STRING", "description": "Canonical name or alias; supply this or exercise_id."},
                "exercise_id": {"type": "STRING", "description": "Permanent exercise ID from the library or a retrieved workout."},
                "limit": {"type": "INTEGER", "description": "Number of recent sessions to retrieve (default 5)"},
            },
        },
    },
    {
        "name": "get_session_summary",
        "description": "Find completed workouts newest first, optionally by title/date. Default lightweight summaries contain IDs, dates, titles, duration, exercise names/IDs and short notes, never sets or weights. Browse candidates, then use get_workout_details for the selected ID. For an already-specific reference or a request for weights/reps use include_details=true (limit=1 for last): full records appear in workout, without duplicated set summaries. Follow nextCursor while hasMore=true, keeping the same filter; a page is not the whole history. Filters match titles/dates, not exercise content; inspect unfiltered summaries if a category title is unmatched. Truncated summary notes are marked; full notes remain in workout details.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "limit": {"type": "INTEGER", "description": "Number of past workouts to retrieve (default 3)"},
                "search_title_or_date": {"type": "STRING", "description": "Optional title or date filter (YYYY-MM-DD). Full body / Ganzkörper title aliases are supported."},
                "include_details": {"type": "BOOLEAN", "description": "Return complete structured workouts including set types, effort and notes (default false). Use true when repeating/adapting a session."},
                "cursor": {"type": "STRING", "description": "Opaque nextCursor from the previous page; keep the same search_title_or_date. Omit for the first page. Invalid/stale cursors require restarting, never guessing."},
            },
        },
    },
    {
        "name": "get_workout_details",
        "description": "Retrieve one exact saved workout by ID returned from a session/history lookup. Returns all recorded exercises, sets, types, effort and notes, including completion status. Use when a specific session is referenced; never invent an ID. Avoid a duplicate lookup if include_details already returned the full workout.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"workout_id": {"type": "STRING", "description": "Exact saved workout ID."}},
            "required": ["workout_id"],
        },
    },
    {
        "name": "resolve_exercise",
        "description": "Resolve any colloquial exercise wording to the permanent canonical library name and ID before logging. Returns resolved, ambiguous or not_found. Use the canonical name; ask on ambiguity. On not_found, discover add_exercise, add once and retry the intended action.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": {"type": "STRING", "description": "Colloquial, translated or partial exercise name"},
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
        "description": "Retrieve a compact deterministic progression recommendation from actual completed sets versus preserved plan values. Searches up to three comparable sessions for the canonical exercise. Returns evidence, reason and proposed next targets; never changes a plan. Use instead of inventing percentages from one set. Missing plans, effort or equipment increments are explicitly reported.",
        "parameters": {"type":"OBJECT", "properties": {
            "exercise_id":{"type":"STRING", "description":"Permanent exercise ID, preferred."},
            "exercise_name":{"type":"STRING", "description":"Canonical name or unambiguous alias if ID unknown."},
        }},
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
    # The model may propose a valid exercise that is not in this user's library yet.
    # Add it once, then build the proposal against the canonical persisted record.
    for planned in args.get("exercises") or []:
        supplied_name = (planned.get("exerciseName") or "").strip()
        if not supplied_name:
            continue
        match, _ = resolve_exercise(db.get("exercises", []), supplied_name)
        if match:
            continue

        canonical_name = ALIASES.get(normalize_exercise_name(supplied_name), supplied_name)
        category = planned.get("category") or (
            "Plyometrics" if "jump" in normalize_exercise_name(canonical_name)
            or "sprung" in normalize_exercise_name(canonical_name)
            else "Other"
        )
        equipment = planned.get("equipment") or (
            "Bodyweight" if category == "Plyometrics" else "Other"
        )
        new_exercise = {
            "id": _now_id("ex_ai"),
            "name": canonical_name,
            "category": category,
            "equipment": equipment,
            "instructions": planned.get("notes") or "Added from an AI workout proposal.",
            "isCustom": True,
        }
        crud.save_user_exercise(session, user_id, new_exercise)
        db.setdefault("exercises", []).append(new_exercise)

    return {"type": "workout_proposed", "data": build_workout_proposal(db, args)}


def handle_log_set(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    active_workout_state = kwargs.get("active_workout_state")
    if not active_workout_state or not isinstance(active_workout_state.get("exercises"), list):
        raise ValueError("No active workout. Start a workout before logging a set.")
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
        canonical, candidates = resolve_exercise(db["exercises"], ex_name)
        if not canonical:
            detail = ", ".join(item["name"] for item in candidates[:5]) if candidates else "no library match"
            raise ValueError(f'Exercise "{ex_name}" is not canonical ({detail})')
        we = next((e for e in active_workout_state["exercises"]
                   if e.get("exerciseId") == canonical["id"]), None)
        if not we:
            we = {
                "id": _now_id("we"),
                "exerciseId": canonical["id"],
                "exerciseName": canonical["name"],
                "category": canonical["category"],
                "sets": [],
            }
            active_workout_state["exercises"].append(we)

        # Look for the first uncompleted set or append new
        pending = next((s for s in we.get("sets", []) if not s.get("completed")), None)
        if pending:
            # Preserve an existing prescription; never reconstruct it after logging.
            if not pending.get("planned") and pending.get("reps", 0) > 0:
                pending["planned"] = {"weight": pending.get("weight", 0), "reps": pending.get("reps", 0), "type": pending.get("type", "working")}
            pending["weight"] = weight
            pending["reps"] = reps
            pending["type"] = set_type
            pending["completed"] = True
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
                "rpe": rpe,
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

    if not corrected:
        raise ValueError("Set not found in the active workout; nothing was corrected.")

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


def _history_limit(args: dict, default: int) -> int:
    return max(1, min(10, int(args.get("limit") or default)))


def _completed_workouts(db: dict) -> list[dict]:
    # Stable sort preserves the database's created_at/ID order within each day.
    return sorted((w for w in db.get("workouts", []) if w.get("isCompleted", True)),
                  key=lambda w: w.get("date") or "", reverse=True)


def _recorded_sets(exercise: dict) -> list[dict]:
    # History is an outcome projection. Full prescriptions remain available via
    # get_workout_details; progression uses its own bounded evidence projection.
    return [{**{key: deepcopy(s[key]) for key in ("id", "setNumber", "type", "weight", "reps", "rpe", "completed") if key in s},
             **({"notes": str(s["notes"])[:300]} if s.get("notes") else {})}
            for s in exercise.get("sets", []) if s.get("completed")][:20]


def handle_get_exercise_history(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    exercise_id = args.get("exercise_id")
    query = (args.get("exercise_name") or "").strip()
    if exercise_id:
        match = next((e for e in db.get("exercises", []) if e["id"] == exercise_id), None)
        candidates = []
    else:
        match, candidates = resolve_exercise(db.get("exercises", []), query)
    if not match:
        return {
            "status": "ambiguous" if candidates else "not_found",
            "query": query, "history": [],
            "candidates": [{"id": e["id"], "name": e["name"]} for e in candidates[:5]],
            "message": "Clarify the exercise; no performance was selected." if candidates else "No matching library exercise or logged baseline found.",
        }

    history_entries = []
    for workout in _completed_workouts(db):
        for exercise in workout.get("exercises", []):
            # IDs are authoritative. Only legacy records without IDs use names.
            if exercise.get("exerciseId"):
                matches = exercise["exerciseId"] == match["id"]
            else:
                legacy, _ = resolve_exercise(db.get("exercises", []), exercise.get("exerciseName", ""))
                matches = bool(legacy and legacy["id"] == match["id"])
            if not matches:
                continue
            sets = _recorded_sets(exercise)
            if not sets:
                continue
            history_entries.append({
                "workoutId": workout["id"], "date": workout.get("date"),
                "workoutTitle": workout.get("title"), "exerciseId": match["id"],
                "sets": sets, "notes": exercise.get("notes"),
            })
        if len(history_entries) >= _history_limit(args, 5):
            break
    return {
        "status": "found" if history_entries else "no_history",
        "exercise": match["name"], "exerciseId": match["id"],
        "pr": match.get("personalRecord") or {},
        "history": history_entries[:_history_limit(args, 5)],
    }


_FULL_BODY_NAMES = ("full body", "fullbody", "full body workout", "ganzkorper", "ganzkoerper")


def _matches_workout_title_or_date(workout: dict, query: str) -> bool:
    normalized = normalize_exercise_name(query)
    title = normalize_exercise_name(workout.get("title", ""))
    if normalized in _FULL_BODY_NAMES:
        return any(alias in title for alias in _FULL_BODY_NAMES)
    return normalized in title or query in (workout.get("date") or "")


def _session_cursor(workout: dict, query: str) -> str:
    value = {'v': 1, 'id': workout['id'], 'date': workout.get('date'), 'filter': query}
    return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).decode()


def _read_session_cursor(cursor, query, workouts):
    try:
        if not isinstance(cursor, str) or len(cursor) > 2048:
            raise ValueError('Invalid cursor')
        value = json.loads(base64.b64decode(cursor.encode(), altchars=b'-_', validate=True))
        if (not isinstance(value, dict) or set(value) != {'v', 'id', 'date', 'filter'}
                or value['v'] != 1 or value['filter'] != query):
            raise ValueError('Cursor filter/version mismatch')
        # Resolve only against this account's filtered snapshot. A cursor never
        # authorizes a global workout lookup. Newer insertions do not shift it.
        for index, workout in enumerate(workouts):
            if workout['id'] == value['id'] and workout.get('date') == value['date']:
                return index + 1
    except (ValueError, TypeError, UnicodeError, KeyError):
        pass
    raise ValueError('Invalid or stale session cursor; restart without cursor using the intended filter.')


def handle_get_session_summary(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    query = (args.get("search_title_or_date") or "").strip().lower()
    workouts = [workout for workout in _completed_workouts(db)
                if not query or _matches_workout_title_or_date(workout, query)]
    offset = _read_session_cursor(args['cursor'], query, workouts) if 'cursor' in args else 0
    limit = _history_limit(args, 3)
    page = workouts[offset:offset + limit]
    detailed = bool(args.get('include_details'))
    summaries = []
    for workout in page:
        summary = {'id': workout['id'], 'date': workout.get('date'), 'title': workout.get('title'),
                   'durationMinutes': workout.get('durationMinutes')}
        if detailed:
            summary['workout'] = deepcopy(workout)
        else:
            notes = workout.get('notes') or ''
            summary.update(
                exercises=[{'exerciseId': exercise.get('exerciseId'), 'exerciseName': exercise.get('exerciseName')}
                           for exercise in workout.get('exercises', [])],
                notes=notes[:300] or None, notesTruncated=len(notes) > 300)
        summaries.append(summary)
    has_more = offset + len(page) < len(workouts)
    return {'sessions': summaries, 'order': 'newest_first', 'filter': query or None,
            'projection': 'detailed' if detailed else 'summary',
            'returned': len(page), 'effectiveLimit': limit,
            'hasMore': has_more, 'nextCursor': _session_cursor(page[-1], query) if has_more else None,
            'coverage': 'Completed workouts matching the title/date filter in the current account snapshot; not semantic category search.',
            'message': None if summaries else 'No matching completed workout on this page. Category filters match titles only; inspect unfiltered summaries before concluding no relevant workout exists.'}


def handle_get_workout_details(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    # db is scoped to the authenticated user; never query a global ID without ownership.
    workout_id = args.get("workout_id")
    workout = next((w for w in db.get("workouts", []) if w.get("id") == workout_id), None)
    if not workout:
        return {"status": "not_found", "message": "Workout not found in this user's saved workouts."}
    return {"status": "found", "workout": deepcopy(workout)}


def handle_resolve_exercise(session: Session, user_id: int, db: dict, args: dict, **kwargs) -> dict:
    query = (args.get("query") or "").strip()
    match, candidates = resolve_exercise(db.get("exercises", []), query)
    if match:
        return {"status": "resolved", "exerciseName": match["name"], "id": match["id"], "category": match["category"]}
    if candidates:
        return {"status": "ambiguous", "candidates": [m["name"] for m in candidates[:5]], "message": "Multiple matches found. Clarify with user."}
    return {"status": "not_found", "query": query, "message": "No matching exercise. Add it to the library before logging."}


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
    return recommend_progression(db, exercise_id=args.get("exercise_id"), exercise_name=args.get("exercise_name", ""))


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
        supplied_name = ex_item.get("exerciseName") or ""
        match, candidates = resolve_exercise(db["exercises"], supplied_name)
        if not match:
            detail = ", ".join(item["name"] for item in candidates[:5]) if candidates else "no library match"
            raise ValueError(
                f'Exercise "{supplied_name}" is not canonical ({detail}). '
                "Call resolve_exercise, or add_exercise if it is genuinely new, then retry log_workout."
            )
        sets = []
        for s_idx, s in enumerate(ex_item.get("sets", [])):
            w, r = s.get("weight", 0) or 0, s.get("reps", 0) or 0
            total_volume += w * r
            sets.append({"id": f"s_{int(time.time()*1000)}_{ex_idx}_{s_idx}", "setNumber": s_idx + 1,
                         "type": s.get("type", "working"), "weight": w, "reps": r,
                         "rpe": s.get("rpe", 8), "completed": True})
        exercises_out.append({"id": f"we_{int(time.time()*1000)}_{ex_idx}",
                              "exerciseId": match["id"],
                              "exerciseName": match["name"],
                              "category": match["category"],
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
    "get_workout_details": handle_get_workout_details,
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
