import unittest
from unittest.mock import patch

from app.agent.workout_builder import build_workout_proposal
from app.agent.tools import handle_start_workout_session

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

    @patch("app.agent.tools.crud.save_user_exercise")
    def test_adds_unknown_exercise_before_building_proposal(self, save_user_exercise):
        database = {"exercises": []}
        result = handle_start_workout_session(None, 1, database, {
            "title": "Jump session",
            "exercises": [{
                "exerciseName": "CMJ",
                "sets": [{"weight": 0, "reps": 3, "setType": "working"}],
            }],
        })

        self.assertEqual(result["type"], "workout_proposed")
        self.assertEqual(result["data"]["exercises"][0]["exerciseName"], "Countermovement Jumps")
        save_user_exercise.assert_called_once()


if __name__ == "__main__":
    unittest.main()
