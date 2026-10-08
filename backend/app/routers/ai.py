"""AI API — the FastAPI port of the /api/ai/* routes from server.ts."""
import time
import uuid

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlmodel import Session

from ..agent import coach
from ..auth import current_user
from ..db import get_session
from ..memory import conversational as memory
from ..models import User
from ..observability import read_user_usage_summary, update_round_trip_ms, write_ai_request_metric

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/history")
def chat_history(
    thread_id: str | None = Query(default=None, alias="threadId"),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    memory.ensure_default_chat_session(session, user.id)
    thread_id = thread_id or str(user.id)
    if not memory.get_owned_chat_session(session, user.id, thread_id):
        raise HTTPException(status_code=404, detail="Chat session not found")
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
    thread_id: str | None = Query(default=None, alias="threadId"),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    memory.ensure_default_chat_session(session, user.id)
    thread_id = thread_id or str(user.id)
    if not memory.get_owned_chat_session(session, user.id, thread_id):
        raise HTTPException(status_code=404, detail="Chat session not found")
    memory.clear_message_history(session, user.id, thread_id)
    return {"success": True}


@router.get("/sessions")
def chat_sessions(user: User = Depends(current_user), session: Session = Depends(get_session)):
    return {"sessions": [
        {
            "id": item.id,
            "title": item.title,
            "createdAt": item.created_at.isoformat() if item.created_at else None,
            "updatedAt": item.updated_at.isoformat() if item.updated_at else None,
        }
        for item in memory.list_chat_sessions(session, user.id)
    ]}


@router.post("/sessions")
def new_chat_session(
    payload: dict = Body(default={}),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    item = memory.create_chat_session(session, user.id, payload.get("title", "New chat"))
    return {"session": {"id": item.id, "title": item.title}}


@router.delete("/sessions/{thread_id}")
def remove_chat_session(
    thread_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    if not memory.delete_chat_session(session, user.id, thread_id):
        raise HTTPException(status_code=404, detail="Chat session not found")
    return {"success": True}


@router.post("/chat")
def chat(
    payload: dict = Body(...),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    request_id = str(uuid.uuid4())
    request_started = time.perf_counter()
    memory.ensure_default_chat_session(session, user.id)
    thread_id = str(payload.get("threadId") or user.id)
    chat_session = memory.get_owned_chat_session(session, user.id, thread_id)
    if chat_session is None:
        raise HTTPException(status_code=404, detail="Chat session not found")
    try:
        result = coach.run_chat(
            session, user,
            message=payload.get("message", ""),
            active_workout_state=payload.get("activeWorkoutState"),
            request_id=request_id,
            thread_id=thread_id,
        )
    except Exception as error:
        session.rollback()
        elapsed_ms = round((time.perf_counter() - request_started) * 1000)
        failure_trace = {
            "requestId": request_id,
            "totalMs": elapsed_ms,
            "agentSteps": 0,
            "modelMs": 0,
            "toolMs": 0,
            "contextMs": 0,
            "persistenceMs": 0,
            "slowestStep": None,
            "steps": [],
        }
        write_ai_request_metric(
            session,
            user_id=user.id,
            thread_id=thread_id,
            trace=failure_trace,
            status="error",
            error_type=type(error).__name__,
        )
        raise

    memory.touch_chat_session(session, chat_session, payload.get("message", ""))
    write_ai_request_metric(
        session,
        user_id=user.id,
        thread_id=thread_id,
        trace=result["trace"],
        usage=result.get("usage"),
        tools_used=result.get("toolsUsed"),
    )
    return result


@router.patch("/metrics/roundtrip")
def store_round_trip(
    payload: dict = Body(...),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    updated = update_round_trip_ms(
        session,
        user_id=user.id,
        request_id=str(payload.get("requestId", "")),
        round_trip_ms=int(payload.get("roundTripMs", 0)),
    )
    return {"updated": updated}


@router.get("/usage")
def usage_summary(
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    return read_user_usage_summary(session, user_id=user.id)


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
