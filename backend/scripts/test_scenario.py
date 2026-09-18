"""Test the real user scenario: soreness + full body without legs.
Expect: NO memory save (it's temporary), a workout PROPOSAL, and a coaching text."""
import sys
sys.path.insert(0, ".")

from sqlalchemy import text
from sqlmodel import Session, select

from app.agent import coach
from app.db import engine
from app.models import Profile, User

with Session(engine) as s:
    user = s.exec(select(User).where(User.id == 1)).first()
    prof = s.exec(select(Profile).where(Profile.user_id == 1)).first()
    before_mem = list(prof.personal_memories or [])

    msg = ("Ok, neue Woche. Hab Knie-Muskelkater von einer Wanderung, "
           "also wieder Full Body aber ohne Beine/Knie.")
    r = coach.run_chat(s, user, msg, None)

    print("=== REPLY ===")
    print(r["reply"][:1000])
    print("\n=== TOOLS USED ===", r["toolsUsed"])
    print("=== ACTION ===", (r["actionExecuted"] or {}).get("type"))
    if r["actionExecuted"] and r["actionExecuted"].get("type") == "workout_proposed":
        exs = r["actionExecuted"]["data"]["exercises"]
        print("=== PROPOSED EXERCISES ===", [e["exerciseName"] for e in exs])

    # cleanup: wipe thread 1 + restore memories exactly as they were
    s.exec(text("DELETE FROM messages WHERE thread_id='1'"))
    s.exec(text("DELETE FROM summaries WHERE thread_id='1'"))
    prof = s.exec(select(Profile).where(Profile.user_id == 1)).first()
    prof.personal_memories = before_mem
    s.add(prof)
    s.commit()
    print("\n[cleaned up thread 1 + restored memories]")
