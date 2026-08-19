"""Validate automatic summarization + JIT expand on a scratch thread."""
import sys
sys.path.insert(0, ".")

from sqlalchemy import text
from sqlmodel import Session, select

from app.db import engine
from app.memory import conversational as memory
from app.memory import summary as summ
from app.models import Message

T = "test_summary_thread"

with Session(engine) as s:
    convo = [
        ("user", "My main goal is to hit a 140kg deadlift by December."),
        ("assistant", "Got it — 140kg deadlift by December is the target."),
        ("user", "I have a slight lower-back niggle, so keep volume moderate."),
        ("assistant", "Noted, moderate volume, protect the lower back."),
        ("user", "Today I did squats 100kg x 5 for 3 sets."),
        ("assistant", "Logged. Solid squat session."),
    ]
    for role, content in convo:
        memory.write_message(s, 1, T, role, content)

    result = summ.summarize_conversation(s, 1, T)
    print("summary id:", result["id"], "| label:", result["description"])
    print("messages summarized:", result["num_messages"])

    remaining = memory.read_recent_messages(s, 1, T, limit=10)
    print("un-summarized messages left in active context:", len(remaining))

    print("\nsummary context block:\n" + summ.read_summary_context(s, 1, T))
    print("\nexpand_summary preview:\n" + summ.expand_summary(s, result["id"])[:200])

    # cleanup
    s.exec(text("DELETE FROM messages WHERE thread_id=:t"), params={"t": T})
    s.exec(text("DELETE FROM summaries WHERE thread_id=:t"), params={"t": T})
    s.commit()
    print("\ncleaned up scratch thread")
