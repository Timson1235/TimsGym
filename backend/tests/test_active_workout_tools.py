import unittest
from unittest.mock import patch

from app.agent.tools import handle_modify_active_workout


class ActiveWorkoutToolTests(unittest.TestCase):
    def setUp(self):
        self.database = {
            "exercises": [
                {"id": "squat", "name": "Barbell Back Squat", "category": "Legs", "equipment": "Barbell"},
            ],
        }
        self.active = {
            "id": "active",
            "exercises": [{
                "id": "we_1",
                "exerciseId": "squat",
                "exerciseName": "Barbell Back Squat",
                "category": "Legs",
                "sets": [{
                    "id": "set_1", "setNumber": 1, "type": "working",
                    "weight": 60, "reps": 5, "completed": False,
                }],
            }],
        }

    def test_replaces_exercise_and_preserves_sets(self):
        with patch("app.agent.tools.crud.save_user_exercise"):
            result = handle_modify_active_workout(
                None, 1, self.database,
                {"operation": "replace_exercise", "current_exercise": "Kniebeuge", "new_exercise": "Front Squat"},
                active_workout_state=self.active,
            )

        exercise = self.active["exercises"][0]
        self.assertEqual(result["type"], "active_workout_updated")
        self.assertEqual(exercise["exerciseName"], "Front Squat")
        self.assertEqual(exercise["sets"][0]["weight"], 60)
        self.assertEqual(self.database["exercises"][-1]["name"], "Front Squat")

    def test_adds_unknown_exercise_to_library_and_active_session(self):
        with patch("app.agent.tools.crud.save_user_exercise") as save_exercise:
            result = handle_modify_active_workout(
                None, 1, self.database,
                {
                    "operation": "add_exercise",
                    "new_exercise": "Landmine Press",
                    "category": "Shoulders",
                    "equipment": "Barbell",
                    "sets": [{"weight": 20, "reps": 8, "setType": "working"}],
                },
                active_workout_state=self.active,
            )

        self.assertEqual(result["type"], "active_workout_updated")
        self.assertEqual(self.active["exercises"][-1]["exerciseName"], "Landmine Press")
        self.assertEqual(self.active["exercises"][-1]["sets"][0]["reps"], 8)
        save_exercise.assert_called_once()

    def test_removes_exercise_from_active_session_only(self):
        result = handle_modify_active_workout(
            None, 1, self.database,
            {"operation": "remove_exercise", "current_exercise": "Barbell Back Squat"},
            active_workout_state=self.active,
        )

        self.assertEqual(result["type"], "active_workout_updated")
        self.assertEqual(self.active["exercises"], [])
        self.assertEqual(len(self.database["exercises"]), 1)


if __name__ == "__main__":
    unittest.main()
