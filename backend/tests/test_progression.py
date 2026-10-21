import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.agent.coach import suggest_weight
from app.agent.tools import handle_log_set, handle_correct_log


class ProgressionTests(unittest.TestCase):
    def suggest(self, sets, completed=True):
        db = {"exercises": [{"id": "squat", "name": "Barbell Back Squat"}],
              "workouts": [{"date": "2026-10-20", "isCompleted": completed,
                            "exercises": [{"exerciseId": "squat", "sets": sets}]}]}
        with patch("app.agent.coach.crud.get_user_database_state", return_value=db):
            return suggest_weight(None, SimpleNamespace(id=1), "Barbell Back Squat", 6, 8)

    def test_suggests_rep_progression_only_with_reserve_on_every_set(self):
        sets = [{"type": "working", "completed": True, "weight": 65, "reps": 6, "rpe": 7}] * 3
        result = self.suggest(sets)
        self.assertEqual((result["suggestedWeight"], result["suggestedReps"]), (65, 7))
        self.assertIn("2026-10-20", result["reasoning"])

    def test_missing_effort_or_missed_reps_holds_target(self):
        for reps, rpe in [(6, None), (5, 7), (6, 9)]:
            with self.subTest(reps=reps, rpe=rpe):
                result = self.suggest([{"completed": True, "weight": 65, "reps": reps, "rpe": rpe}])
                self.assertEqual((result["suggestedWeight"], result["suggestedReps"]), (65, 6))

    def test_no_arbitrary_baseline_from_warmups_or_unfinished_workouts(self):
        self.assertIsNone(self.suggest([{"type": "warmup", "completed": True, "weight": 20}])["suggestedWeight"])
        self.assertIsNone(self.suggest([], completed=False)["suggestedWeight"])

    def test_logging_and_correction_cannot_report_success_without_a_workout(self):
        with self.assertRaises(ValueError):
            handle_log_set(None, 1, {}, {"exercise_name": "Squat", "weight": 65, "reps": 6})
        with self.assertRaises(ValueError):
            handle_correct_log(None, 1, {}, {"exercise_name": "Squat", "new_weight": 65})

    def test_mixed_loads_need_individual_coaching(self):
        self.assertIsNone(self.suggest([
            {"completed": True, "weight": 60}, {"completed": True, "weight": 65},
        ])["suggestedWeight"])
