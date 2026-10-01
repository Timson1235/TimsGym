"""AI API — the FastAPI port of the /api/ai/* routes from server.ts."""
from fastapi import APIRouter, Body, Depends
from sqlmodel import Session

from ..agent import coach
from ..auth import current_user
from ..db import get_session
from ..memory import conversational as memory
from ..models import User

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/history")
def chat_history(
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    thread_id = str(user.id)
    messages = memory.read_message_history(session, user.id, thread_id)
    return {
        "messages": [
            {
                "id": f"server_{message.id}",
                "role": message.role,
                "content": message.content,
                "createdAt": message.created_at.isoformat() if message.created_at else None,
            }
            for message in messages
        ]
    }


@router.delete("/history")
def clear_chat_history(
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    memory.clear_message_history(session, user.id, str(user.id))
    return {"success": True}


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
