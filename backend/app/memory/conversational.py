"""Conversational memory + tool-call log (the non-vector memory types).

Keyed by (user_id, thread_id). We use one thread per user by default
("thread per user"), so the coach has continuous context.
"""
from typing import Optional

from sqlmodel import Session, select

from ..models import Message, ToolLog
from .flags import flags


def write_message(session: Session, user_id: int, thread_id: str, role: str, content: str) -> None:
    if not flags.conversational or not content:
        return
    session.add(Message(user_id=user_id, thread_id=thread_id, role=role, content=content))
    session.commit()


def read_recent_messages(session: Session, user_id: int, thread_id: str, limit: int = 10) -> list[Message]:
    """Most-recent `limit` un-summarized messages, returned in chronological order."""
    if not flags.conversational:
        return []
    rows = session.exec(
        select(Message)
        .where(Message.user_id == user_id, Message.thread_id == thread_id, Message.summary_id == None)  # noqa: E711
        .order_by(Message.id.desc())
        .limit(limit)
    ).all()
    return list(reversed(rows))


def write_tool_log(
    session: Session, user_id: int, thread_id: str, tool_name: str,
    tool_args: Optional[dict], result: Optional[str],
    status: str = "success", error_message: Optional[str] = None,
) -> None:
    if not flags.tool_log:
        return
    session.add(ToolLog(
        user_id=user_id, thread_id=thread_id, tool_name=tool_name, tool_args=tool_args,
        result=(result or "")[:8000], status=status, error_message=error_message,
    ))
    session.commit()
