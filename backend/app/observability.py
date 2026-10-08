"""Persistence helpers for sanitized AI request performance telemetry."""
import json
from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Session, select

from .models import AIRequestMetric, ChatSession


def ensure_observability_schema() -> None:
    """Create only the telemetry table and indexes when they are missing."""
    from .db import engine
    ChatSession.__table__.create(bind=engine, checkfirst=True)
    AIRequestMetric.__table__.create(bind=engine, checkfirst=True)


def write_ai_request_metric(
    session: Session,
    *,
    user_id: int,
    thread_id: str,
    trace: dict,
    usage: Optional[dict] = None,
    tools_used: Optional[list[str]] = None,
    status: str = "success",
    error_type: Optional[str] = None,
) -> None:
    usage = usage or {}
    slowest = trace.get("slowestStep") or {}
    metric = AIRequestMetric(
        request_id=trace["requestId"],
        user_id=user_id,
        thread_id=thread_id,
        status=status,
        provider=usage.get("provider"),
        model=usage.get("model"),
        total_ms=trace.get("totalMs", 0),
        agent_steps=trace.get("agentSteps", 0),
        model_ms=trace.get("modelMs", 0),
        tool_ms=trace.get("toolMs", 0),
        context_ms=trace.get("contextMs", 0),
        persistence_ms=trace.get("persistenceMs", 0),
        slowest_step_name=slowest.get("name"),
        slowest_step_kind=slowest.get("kind"),
        slowest_step_ms=slowest.get("durationMs"),
        input_tokens=usage.get("inputTokens", 0),
        output_tokens=usage.get("outputTokens", 0),
        total_tokens=usage.get("totalTokens", 0),
        estimated_cost_usd=usage.get("estimatedCostUsd", 0.0),
        tools_used=tools_used or [],
        steps=trace.get("steps", []),
        error_type=error_type,
    )
    try:
        session.add(metric)
        session.commit()
    except Exception as error:
        session.rollback()
        print(json.dumps({
            "event": "ai_metric_write_failed",
            "requestId": trace.get("requestId"),
            "errorType": type(error).__name__,
        }, separators=(",", ":")))


def update_round_trip_ms(
    session: Session,
    *,
    user_id: int,
    request_id: str,
    round_trip_ms: int,
) -> bool:
    metric = session.exec(
        select(AIRequestMetric).where(
            AIRequestMetric.request_id == request_id,
            AIRequestMetric.user_id == user_id,
        )
    ).first()
    if not metric:
        return False
    metric.round_trip_ms = max(0, round_trip_ms)
    session.add(metric)
    session.commit()
    return True


def read_user_usage_summary(session: Session, *, user_id: int) -> dict:
    """Aggregate persisted token usage and estimated cost for one account."""
    rows = session.exec(
        select(AIRequestMetric).where(AIRequestMetric.user_id == user_id)
    ).all()
    now = datetime.now(timezone.utc)

    def summarize(items: list[AIRequestMetric]) -> dict:
        return {
            "requests": len(items),
            "inputTokens": sum(item.input_tokens or 0 for item in items),
            "outputTokens": sum(item.output_tokens or 0 for item in items),
            "totalTokens": sum(item.total_tokens or 0 for item in items),
            "estimatedCostUsd": round(sum(item.estimated_cost_usd or 0 for item in items), 8),
        }

    this_month = [
        item for item in rows
        if item.created_at
        and item.created_at.year == now.year
        and item.created_at.month == now.month
    ]
    return {
        "allTime": summarize(rows),
        "currentMonth": summarize(this_month),
        "trackingSince": min(
            (item.created_at.isoformat() for item in rows if item.created_at),
            default=None,
        ),
    }
