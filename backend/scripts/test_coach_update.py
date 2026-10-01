"""Verification test script for the updated Coach logic, prompt, tools, and arithmetic weights."""
import sys
import os
sys.path.insert(0, ".")

# Set UTF-8 output encoding for Windows consoles
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from sqlmodel import Session, select
from app.db import engine
from app.models import User, Profile
from app import crud
from app.agent import coach, tools


def test_arithmetic_suggest_weight():
    print("--- 1. Testing calculate_suggested_weight ---")
    w1, r1 = tools.calculate_suggested_weight(70.0, None)
    assert w1 == 70.0 and "kein RIR" in r1, f"Expected 70.0, got {w1} ({r1})"

    w2, r2 = tools.calculate_suggested_weight(70.0, 1)
    assert w2 == 70.0 and "RIR ≤1" in r2, f"Expected 70.0, got {w2} ({r2})"

    w3, r3 = tools.calculate_suggested_weight(70.0, 2)
    # 70 * 1.025 = 71.75 -> round(71.75 / 2.5) * 2.5 = 29.0 * 2.5 = 72.5
    assert w3 == 72.5 and "RIR 2" in r3, f"Expected 72.5, got {w3} ({r3})"

    w4, r4 = tools.calculate_suggested_weight(70.0, 3)
    # 70 * 1.05 = 73.5 -> round(73.5 / 2.5) * 2.5 = 29.0 * 2.5 = 72.5 or 75.0
    assert w4 in (72.5, 75.0) and "RIR 3+" in r4, f"Expected 72.5 or 75.0, got {w4} ({r4})"

    print(f"  Passed: RIR None -> {w1}kg ({r1})")
    print(f"  Passed: RIR 1    -> {w2}kg ({r2})")
    print(f"  Passed: RIR 2    -> {w3}kg ({r3})")
    print(f"  Passed: RIR 3    -> {w4}kg ({r4})")


def test_prompt_generation():
    print("\n--- 2. Testing _build_system_instruction ---")
    with Session(engine) as s:
        user = s.exec(select(User).where(User.id == 1)).first()
        db = crud.get_user_database_state(s, user.id)

        # A) Planning mode
        prompt_planning = coach._build_system_instruction(db, None)
        assert "=== USER DATA ===" in prompt_planning
        assert "Keine aktive Session (Planungs-Modus)." in prompt_planning
        assert "Hauptlifte, letzte 3 Werte:" in prompt_planning
        assert "Alles Weitere über Tools abrufen." in prompt_planning
        assert "════ THE BAR ════" in prompt_planning
        assert "════ TWO MODES ════" in prompt_planning
        print("  Passed: Planning mode prompt contains all required sections.")

        # B) In-session mode
        active_session = {
            "id": "wk_active_test",
            "title": "Push Day",
            "exercises": [
                {
                    "exerciseName": "Bankdrücken",
                    "sets": [{"setNumber": 1, "weight": 70, "reps": 6, "completed": True, "rpe": 8}]
                },
                {
                    "exerciseName": "Schulterdrücken",
                    "sets": [{"setNumber": 1, "weight": 40, "reps": 8, "completed": False}]
                }
            ]
        }
        prompt_session = coach._build_system_instruction(db, active_session)
        assert "Aktive Session: 2/2, erledigt: [Bankdrücken], offen: [Schulterdrücken]" in prompt_session
        assert "Zuletzt geloggt: Bankdrücken 70x6 (working, RIR 2.0)" in prompt_session
        print("  Passed: In-session mode prompt correctly formats active blocks and last logged set.")


def test_tools_and_flags():
    print("\n--- 3. Testing tools, history, and flags ---")
    with Session(engine) as s:
        user = s.exec(select(User).where(User.id == 1)).first()
        db = crud.get_user_database_state(s, user.id)

        # Resolve exercise
        res1 = tools.handle_resolve_exercise(s, user.id, db, {"query": "Bank"})
        print(f"  resolve_exercise('Bank') -> {res1}")

        # Exercise history
        hist = tools.handle_get_exercise_history(s, user.id, db, {"exercise_name": "Bankdrücken", "limit": 3})
        print(f"  get_exercise_history('Bankdrücken') -> {len(hist.get('history', []))} sessions found.")

        # Session summary
        summ = tools.handle_get_session_summary(s, user.id, db, {"limit": 2})
        print(f"  get_session_summary(limit=2) -> {len(summ.get('sessions', []))} sessions found.")

        # Open flag & resolve flag
        flg = tools.handle_open_flag(s, user.id, db, {"flag_type": "symptom", "note": "Test-Knieschmerz", "date": "2026-09-18"})
        print(f"  open_flag -> {flg}")
        assert any(f.get("note") == "Test-Knieschmerz" for f in db["profile"].get("openFlags", []))

        # Check that prompt reflects open flag
        prompt_with_flag = coach._build_system_instruction(db, None)
        assert "Test-Knieschmerz" in prompt_with_flag
        print("  Passed: Open flag reflected in USER DATA block.")

        # Resolve flag
        resolved = tools.handle_resolve_flag(s, user.id, db, {"keyword_or_id": "Test-Knieschmerz"})
        print(f"  resolve_flag -> {resolved}")
        assert not any(f.get("note") == "Test-Knieschmerz" for f in db["profile"].get("openFlags", []))
        print("  Passed: Flag successfully resolved and cleared from DB.")


def test_coach_suggest_weight():
    print("\n--- 4. Testing coach.suggest_weight (arithmetic endpoint) ---")
    with Session(engine) as s:
        user = s.exec(select(User).where(User.id == 1)).first()
        res = coach.suggest_weight(s, user, exercise_name="Bankdrücken", target_reps=8, target_rpe=8)
        print(f"  coach.suggest_weight('Bankdrücken') -> {res}")
        assert "suggestedWeight" in res and res["suggestedWeight"] > 0
        assert "reasoning" in res


if __name__ == "__main__":
    test_arithmetic_suggest_weight()
    test_prompt_generation()
    test_tools_and_flags()
    test_coach_suggest_weight()
    print("\n✅ All coach updates tested and verified successfully!")
