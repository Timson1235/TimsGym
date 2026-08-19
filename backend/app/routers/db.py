"""Data API — the FastAPI port of the /api/db/* routes from server.ts.

All routes require a valid Firebase login (current_user dependency).
Response shapes match what src/lib/api.ts expects:
  GET  /api/db            -> DatabaseState
  POST/DELETE endpoints   -> { success: true, db: DatabaseState }
"""
from fastapi import APIRouter, Body, Depends
from sqlmodel import Session

from .. import crud
from ..auth import current_user
from ..db import get_session
from ..models import User

router = APIRouter(prefix="/api/db", tags=["db"])


@router.get("")
def read_db(user: User = Depends(current_user), session: Session = Depends(get_session)):
    return crud.get_user_database_state(session, user.id)


@router.post("/workout")
def save_workout(
    payload: dict = Body(...),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    crud.save_user_workout(session, user.id, payload)
    crud.update_personal_records(session, user.id, payload)  # Epley PRs
    return {"success": True, "db": crud.get_user_database_state(session, user.id)}


@router.delete("/workout/{workout_id}")
def delete_workout(
    workout_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    crud.delete_user_workout(session, user.id, workout_id)
    return {"success": True, "db": crud.get_user_database_state(session, user.id)}


@router.post("/exercise")
def save_exercise(
    payload: dict = Body(...),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    crud.save_user_exercise(session, user.id, payload)
    return {"success": True, "db": crud.get_user_database_state(session, user.id)}


@router.post("/profile")
def update_profile(
    payload: dict = Body(...),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    crud.update_user_profile(session, user.id, payload)
    return {"success": True, "db": crud.get_user_database_state(session, user.id)}


@router.post("/reset")
def reset_db(user: User = Depends(current_user), session: Session = Depends(get_session)):
    crud.reset_user(session, user.id)
    return {"success": True, "db": crud.get_user_database_state(session, user.id)}
