import unittest

from app.agent.workout_builder import build_workout_proposal
from app.agent.workout_flow import (
    WORKOUT_CONFIRMATION_QUESTION,
    has_pending_workout_draft,
    is_explicit_workout_confirmation,
)


class Message:
    def __init__(self, role: str, content: str):
        self.role = role
        self.content = content


class WorkoutProposalTests(unittest.TestCase):
    def test_preserves_every_confirmed_set(self):
        database = {
            "exercises": [
                {"id": "squat", "name": "Barbell Back Squat", "category": "Legs"},
            ]
        }
        proposal = build_workout_proposal(database, {
            "title": "Ganzkörper Re-Start",
            "exercises": [{
                "exerciseName": "Barbell Back Squat",
                "notes": "Tripod-Fuß, zwei Minuten Pause",
                "sets": [
                    {"weight": 40, "reps": 5, "setType": "warmup"},
                    {"weight": 55, "reps": 6, "setType": "working"},
                    {"weight": 55, "reps": 6, "setType": "working"},
                    {"weight": 55, "reps": 6, "setType": "working"},
                ],
            }],
        }, timestamp=123)

        sets = proposal["exercises"][0]["sets"]
        self.assertEqual([item["weight"] for item in sets], [40.0, 55.0, 55.0, 55.0])
        self.assertEqual([item["reps"] for item in sets], [5, 6, 6, 6])
        self.assertEqual([item["type"] for item in sets], ["warmup", "working", "working", "working"])

    def test_rejects_empty_workout(self):
        with self.assertRaises(ValueError):
            build_workout_proposal({"exercises": []}, {
                "title": "Empty",
                "exercises": [],
            }, timestamp=123)

    def test_requires_draft_and_explicit_confirmation(self):
        history = [Message("assistant", f"Hier ist dein Plan. {WORKOUT_CONFIRMATION_QUESTION}")]
        self.assertTrue(has_pending_workout_draft(history))
        self.assertTrue(is_explicit_workout_confirmation("Ja, starte das Workout"))
        self.assertFalse(is_explicit_workout_confirmation("Mach mir bitte ein Workout"))

    def test_revision_is_not_a_start_confirmation(self):
        self.assertFalse(is_explicit_workout_confirmation("Nein, nimm bei Kniebeugen 6 Wiederholungen"))

    def test_short_german_start_confirmations(self):
        self.assertTrue(is_explicit_workout_confirmation("leg los"))
        self.assertTrue(is_explicit_workout_confirmation("auf gehts"))

    def test_legacy_workout_draft_is_detected(self):
        history = [Message(
            "assistant",
            "Hier ist dein Workout-Plan: Kniebeugen 3x5, Bankdrücken 3x8.",
        )]
        self.assertTrue(has_pending_workout_draft(history))


if __name__ == "__main__":
    unittest.main()
