import unittest
from unittest.mock import patch

from app.agent.exercise_identity import normalize_exercise_name, resolve_exercise
from app.agent.tools import handle_log_workout


LIBRARY = [
    {"id": "squat-1", "name": "Barbell Back Squat", "category": "Legs"},
    {"id": "rdl-1", "name": "Romanian Deadlift", "category": "Legs"},
    {"id": "incline-1", "name": "Schrägbank 30°", "category": "Chest"},
]


class ExerciseIdentityTests(unittest.TestCase):
    def test_german_and_abbreviated_aliases_resolve_to_canonical_ids(self):
        squat, _ = resolve_exercise(LIBRARY, "Kniebeuge")
        rdl, _ = resolve_exercise(LIBRARY, "RDL")
        incline, _ = resolve_exercise(LIBRARY, "Schraegbank 30 Grad")

        self.assertEqual(squat["id"], "squat-1")
        self.assertEqual(rdl["id"], "rdl-1")
        self.assertEqual(incline["id"], "incline-1")
        self.assertEqual(normalize_exercise_name("Schrägbank 30°"), "schragbank 30")

    @patch("app.agent.tools.crud.update_personal_records")
    @patch("app.agent.tools.crud.save_user_workout")
    def test_workout_logging_stores_canonical_name_and_id(self, save_workout, _update_prs):
        db = {"exercises": LIBRARY, "workouts": []}
        result = handle_log_workout(None, 1, db, {
            "title": "Legs",
            "date": "2026-10-07",
            "exercises": [{
                "exerciseName": "Kniebeuge",
                "sets": [{"weight": 60, "reps": 5, "type": "working"}],
            }],
        })

        logged = result["data"]["exercises"][0]
        self.assertEqual(logged["exerciseId"], "squat-1")
        self.assertEqual(logged["exerciseName"], "Barbell Back Squat")
        save_workout.assert_called_once()

    def test_unknown_exercise_cannot_create_dynamic_identity(self):
        db = {"exercises": LIBRARY, "workouts": []}
        with self.assertRaisesRegex(ValueError, "not canonical"):
            handle_log_workout(None, 1, db, {
                "title": "Unknown",
                "exercises": [{
                    "exerciseName": "Mystery Press",
                    "sets": [{"weight": 10, "reps": 10}],
                }],
            })


if __name__ == "__main__":
    unittest.main()
