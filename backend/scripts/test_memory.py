"""Sanity-check conversational memory read/write (no Gemini, no pollution)."""
import sys
sys.path.insert(0, ".")

from sqlmodel import Session, select

import app.agent.coach  # noqa: F401 — import check (compiles the wired coach)
from app.db import engine
from app.memory import conversational as memory
from app.models import Message

TEST_THREAD = "test_scratch_thread"

with Session(engine) as s:
    memory.write_message(s, 1, TEST_THREAD, "user", "My favorite lift is the deadlift.")
    memory.write_message(s, 1, TEST_THREAD, "assistant", "Noted — deadlift it is.")
    history = memory.read_recent_messages(s, 1, TEST_THREAD, limit=10)
    print("read back:", [(m.role, m.content) for m in history])

    # clean up the scratch rows so nothing lingers
    for m in s.exec(select(Message).where(Message.thread_id == TEST_THREAD)).all():
        s.delete(m)
    s.commit()
    print("cleaned up scratch thread")

print("coach import + memory round-trip OK")
