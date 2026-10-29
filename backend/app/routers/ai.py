"""AI API — the FastAPI port of the /api/ai/* routes from server.ts."""
import time
import uuid

from fastapi.responses import StreamingResponse, JSONResponse
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlmodel import Session

from ..agent import coach
from .. import tracing
from ..agent.progression import recommend_progression, workout_review
from ..auth import current_user, trace_admin
from ..db import get_session
from ..memory import conversational as memory
from ..streaming import stream_events
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


def _execute_chat(payload: dict, user: User, session: Session, on_event=None):
    request_id = str(uuid.uuid4())
    thread_id = str(payload.get("threadId") or user.id)
    with tracing.request_trace(session.get_bind(), request_id, user.id, thread_id):
        with tracing.Span('request', 'Coach request', payload) as span:
            result = _execute_chat_body(payload, user, session, request_id, on_event)
            span.output({key: value for key,value in result.items() if key != 'db'})
            return result


def _execute_chat_body(payload: dict, user: User, session: Session, request_id: str, on_event=None):
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
            on_event=on_event,
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


@router.post("/chat")
def chat(
    payload: dict = Body(...),
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    if not payload.get("stream"):
        return _execute_chat(payload, user, session)

    # Authenticate/authorize before sending HTTP 200 or starting any worker.
    memory.ensure_default_chat_session(session, user.id)
    thread_id = str(payload.get("threadId") or user.id)
    if not memory.get_owned_chat_session(session, user.id, thread_id):
        raise HTTPException(status_code=404, detail="Chat session not found")
    bind = session.get_bind()
    identity = User(id=user.id, uid=user.uid, email=user.email)
    session.rollback()  # Release the validation connection while the worker runs.

    def work(emit):
        with Session(bind) as worker_session:
            return _execute_chat(payload, identity, worker_session, emit)

    return StreamingResponse(
        stream_events(work), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


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


@router.get("/workout-review/{workout_id}")
def review_workout(workout_id: str, user: User = Depends(current_user), session: Session = Depends(get_session)):
    from .. import crud
    result = workout_review(crud.get_user_database_state(session, user.id), workout_id)
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="Workout not found")
    return result


@router.post("/suggest-weight")
def suggest_weight(payload: dict = Body(...), user: User = Depends(current_user), session: Session = Depends(get_session)):
    from .. import crud
    try:
        result = recommend_progression(crud.get_user_database_state(session, user.id),
            exercise_id=payload.get("exerciseId"), exercise_name=payload.get("exerciseName", ""),
            progression=payload.get("progression"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    targets = (result.get("next") or {}).get("sets") or []
    return {**result, "suggestedWeight": targets[0]["weight"] if targets else None,
            "suggestedReps": targets[0]["reps"] if targets else None, "recommendation": result["reasoning"]}


@router.get("/traces")
def traces(thread_id: str | None = Query(default=None, alias="threadId"),
           user: User = Depends(trace_admin), session: Session = Depends(get_session)):
    return JSONResponse({"traces": tracing.list_traces(session, user.id, thread_id)}, headers={"Cache-Control":"no-store"})


@router.get("/traces/{trace_id}")
def trace_details(trace_id: str, payloads: bool = False,
                  user: User = Depends(trace_admin), session: Session = Depends(get_session)):
    result = tracing.read_trace(session, user.id, trace_id, payloads)
    if result is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    return JSONResponse(result, headers={"Cache-Control":"no-store"})


@router.get("/traces/{trace_id}/payload/{payload_id}")
def trace_payload(trace_id: str, payload_id: str,
                  user: User = Depends(trace_admin), session: Session = Depends(get_session)):
    from ..models import AgentTracePayload
    if tracing._owned(session, user.id, trace_id) is None:
        raise HTTPException(status_code=404, detail="Trace not found")
    payload = session.get(AgentTracePayload, payload_id)
    if payload is None or payload.trace_id != trace_id:
        raise HTTPException(status_code=404, detail="Payload not found")
    return JSONResponse({"data":payload.data}, headers={"Cache-Control":"no-store"})
