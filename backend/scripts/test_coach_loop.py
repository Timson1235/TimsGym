"""Validate the full coach: multi-turn recall + the tool loop (function responses).
Uses user 1's thread but resets it afterward so nothing lingers."""
import sys
sys.path.insert(0, ".")

from sqlalchemy import text
from sqlmodel import Session, select

from app.agent import coach
from app.db import engine
from app.models import Profile, User

with Session(engine) as s:
    user = s.exec(select(User).where(User.id == 1)).first()

    print("--- turn 1: set a codeword (no tool) ---")
    r1 = coach.run_chat(s, user, "For this chat my codeword is Pineapple. Acknowledge in one short line.", None)
    print("reply:", repr(r1["reply"][:90]), "| action:", r1["actionExecuted"])

    print("--- turn 2: recall (tests multi-turn memory) ---")
    r2 = coach.run_chat(s, user, "What codeword did I just give you?", None)
    print("reply:", repr(r2["reply"][:90]))

    print("--- turn 3: tool call (tests the loop + function responses) ---")
    r3 = coach.run_chat(s, user, "Remember that my goal is a 150kg squat.", None)
    print("reply:", repr(r3["reply"][:90]), "| action:", r3["actionExecuted"])

    # reset thread 1 + remove the test memory
    s.exec(text("DELETE FROM messages WHERE thread_id='1'"))
    s.exec(text("DELETE FROM summaries WHERE thread_id='1'"))
    prof = s.exec(select(Profile).where(Profile.user_id == 1)).first()
    if prof and prof.personal_memories:
        prof.personal_memories = [m for m in prof.personal_memories if "150" not in m]
        s.add(prof)
    s.commit()
    print("cleaned up thread 1")
