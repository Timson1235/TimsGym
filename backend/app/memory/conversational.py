"""Conversational memory + tool-call log (the non-vector memory types).

Keyed by (user_id, thread_id). We use one thread per user by default
("thread per user"), so the coach has continuous context.
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import text
from sqlmodel import Session, delete, select

from ..models import ChatSession, Message, ToolLog
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


def read_message_history(session: Session, user_id: int, thread_id: str, limit: int = 200) -> list[Message]:
    """Visible messages in the active context; summarized turns stay archived."""
    if not flags.conversational:
        return []
    rows = session.exec(
        select(Message)
        .where(Message.user_id == user_id, Message.thread_id == thread_id, Message.summary_id == None)  # noqa: E711
        .order_by(Message.id.desc())
        .limit(limit)
    ).all()
    return list(reversed(rows))


def clear_message_history(session: Session, user_id: int, thread_id: str) -> None:
    session.exec(
        delete(Message).where(Message.user_id == user_id, Message.thread_id == thread_id)
    )
    session.exec(
        text("DELETE FROM summaries WHERE user_id=:uid AND thread_id=:tid"),
        params={"uid": user_id, "tid": thread_id},
    )
    session.commit()


def ensure_default_chat_session(session: Session, user_id: int) -> ChatSession:
    """Attach legacy per-user messages to a visible default session."""
    thread_id = str(user_id)
    chat = session.get(ChatSession, thread_id)
    if chat is None:
        chat = ChatSession(id=thread_id, user_id=user_id, title="Training chat")
        session.add(chat)
        session.commit()
        session.refresh(chat)
    return chat


def list_chat_sessions(session: Session, user_id: int) -> list[ChatSession]:
    ensure_default_chat_session(session, user_id)
    return list(session.exec(
        select(ChatSession)
        .where(ChatSession.user_id == user_id)
        .order_by(ChatSession.updated_at.desc(), ChatSession.created_at.desc())
    ).all())


def create_chat_session(session: Session, user_id: int, title: str = "New chat") -> ChatSession:
    import uuid
    chat = ChatSession(id=str(uuid.uuid4()), user_id=user_id, title=title.strip()[:80] or "New chat")
    session.add(chat)
    session.commit()
    session.refresh(chat)
    return chat


def get_owned_chat_session(session: Session, user_id: int, thread_id: str) -> Optional[ChatSession]:
    chat = session.get(ChatSession, thread_id)
    return chat if chat and chat.user_id == user_id else None


def touch_chat_session(session: Session, chat: ChatSession, first_message: Optional[str] = None) -> None:
    if first_message and chat.title in {"New chat", "Neuer Chat"}:
        compact = " ".join(first_message.strip().split())
        chat.title = compact[:57] + ("..." if len(compact) > 57 else "")
    chat.updated_at = datetime.now(timezone.utc)
    session.add(chat)
    session.commit()


def delete_chat_session(session: Session, user_id: int, thread_id: str) -> bool:
    chat = get_owned_chat_session(session, user_id, thread_id)
    if chat is None:
        return False
    session.exec(text("DELETE FROM tool_logs WHERE user_id=:uid AND thread_id=:tid"), params={"uid": user_id, "tid": thread_id})
    session.exec(text("DELETE FROM messages WHERE user_id=:uid AND thread_id=:tid"), params={"uid": user_id, "tid": thread_id})
    session.exec(text("DELETE FROM summaries WHERE user_id=:uid AND thread_id=:tid"), params={"uid": user_id, "tid": thread_id})
    session.delete(chat)
    session.commit()
    return True


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
