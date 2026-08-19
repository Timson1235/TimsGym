"""Summary memory + automatic summarization + JIT expand.

Ported from summarise_context_window / summarize_conversation / expand_summary
in the course's helper.py, adapted to Postgres + Gemini.
"""
import json
import uuid
from typing import Optional

from google import genai
from google.genai import types
from sqlalchemy import text
from sqlmodel import Session, select

from ..config import settings
from ..models import Message
from .flags import flags
from .store import embed, to_vec_literal

_client: Optional[genai.Client] = None
if settings.GEMINI_API_KEY:
    _client = genai.Client(api_key=settings.GEMINI_API_KEY)

_SUMMARY_PROMPT = """Summarize this fitness-coaching conversation into durable memory so it can be resumed later.
Return JSON with keys:
  "description": an 8-12 word specific label (mention concrete goals/lifts/decisions),
  "summary": a concise summary capturing goals, workouts logged, PRs, injuries/constraints, and open action items.
Do not invent information.

Conversation:
{transcript}"""


def summarize_conversation(session: Session, user_id: int, thread_id: str) -> Optional[dict]:
    """Summarize all un-summarized messages in a thread, store the summary, and
    mark those messages so they drop out of the active context."""
    if not flags.summary or _client is None:
        return None

    rows = session.exec(
        select(Message)
        .where(Message.user_id == user_id, Message.thread_id == thread_id, Message.summary_id == None)  # noqa: E711
        .order_by(Message.id)
    ).all()
    if not rows:
        return None

    transcript = "\n".join(f"[{m.role.upper()}] {m.content}" for m in rows)

    resp = _client.models.generate_content(
        model="gemini-2.5-flash",
        contents=_SUMMARY_PROMPT.format(transcript=transcript[:8000]),
        config=types.GenerateContentConfig(
            response_mime_type="application/json", temperature=0.2,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    try:
        data = json.loads(resp.text or "{}")
    except Exception:
        data = {}
    summary_text = (data.get("summary") or transcript[:500]).strip()
    description = (data.get("description") or "Recent training conversation").strip()[:120]

    summary_id = uuid.uuid4().hex[:8]
    vec = embed(summary_text)
    session.exec(
        text("INSERT INTO summaries (id, user_id, thread_id, description, summary_text, full_content, embedding) "
             "VALUES (:id, :uid, :tid, :desc, :sum, :full, (:emb)::vector)"),
        params={"id": summary_id, "uid": user_id, "tid": thread_id, "desc": description,
                "sum": summary_text, "full": transcript,
                "emb": to_vec_literal(vec) if vec else None},
    )
    for m in rows:
        m.summary_id = summary_id
        session.add(m)
    session.commit()
    return {"id": summary_id, "description": description, "summary": summary_text, "num_messages": len(rows)}


def read_summary_context(session: Session, user_id: int, thread_id: str, k: int = 3) -> str:
    """A '## Summary Memory' block with the compressed text of older conversation,
    so the coach retains long-range context without replaying every message."""
    if not flags.summary:
        return ""
    rows = session.exec(
        text("SELECT id, description, summary_text FROM summaries "
             "WHERE user_id=:uid AND thread_id=:tid ORDER BY created_at DESC LIMIT :k"),
        params={"uid": user_id, "tid": thread_id, "k": k},
    ).all()
    if not rows:
        return ""
    blocks = ["## Summary Memory (older conversation, compressed — treat as remembered context)"]
    for r in rows:
        blocks.append(f"### {r[1]}\n{r[2]}")
    return "\n\n".join(blocks)


def expand_summary(session: Session, summary_id: str) -> str:
    """JIT retrieval: return the summary text + the original messages it compressed."""
    row = session.exec(
        text("SELECT summary_text, full_content FROM summaries WHERE id=:id"),
        params={"id": summary_id},
    ).first()
    if not row:
        return f"Summary {summary_id} not found."
    return f"## Summary\n{row[0]}\n\n## Original messages\n{row[1]}"
