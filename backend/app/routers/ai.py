"""AI API — the FastAPI port of the /api/ai/* routes from server.ts."""
from fastapi import APIRouter, Body, Depends
from sqlmodel import Session

from ..agent import coach
from ..auth import current_user
from ..db import get_session
from ..models import User

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.post("/chat")
def chat(
    payload: dict = Body(...),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    return coach.run_chat(
        session, user,
        message=payload.get("message", ""),
        active_workout_state=payload.get("activeWorkoutState"),
    )


@router.post("/suggest-weight")
def suggest_weight(
    payload: dict = Body(...),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    return coach.suggest_weight(
        session, user,
        exercise_name=payload.get("exerciseName", ""),
        target_reps=payload.get("targetReps", 8),
        target_rpe=payload.get("targetRpe", 8),
    )
