import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.agent import coach

PLAN_REPLY = (
    "Ganzkörper mit Sprüngen: Kniebeuge 4x5 @ 65 kg, RDL 3x6 @ 65 kg. "
    "Soll ich dieses Workout so starten?"
)
WORKOUT_ARGS = {
    "title": "Ganzkörper mit Sprüngen",
    "exercises": [{
        "exerciseName": "Barbell Back Squat",
        "sets": [{"weight": 65, "reps": 5, "setType": "working"}],
    }],
}


def history(*pairs):
    return [SimpleNamespace(role=role, content=content) for role, content in pairs]


class CoachToolSelectionTests(unittest.TestCase):
    """The coach must offer every tool and return the model's reply untouched."""

    def run_chat(self, message, recent_messages, fake_agent, active_workout=None):
        database = {
            "profile": {"name": "Tim"},
            "exercises": [{"id": "squat", "name": "Barbell Back Squat", "category": "Legs"}],
            "workouts": [],
        }
        with patch.object(coach.settings, "CLAUDE_API_KEY", "test-key"), \
                patch.object(coach.crud, "get_user_database_state", return_value=database), \
                patch.object(coach.memory, "read_recent_messages", return_value=recent_messages), \
                patch.object(coach.memory, "write_message"), \
                patch.object(coach.memory, "write_tool_log"), \
                patch.object(coach.context, "should_summarize", return_value=False), \
                patch.object(coach.summ, "read_summary_context", return_value=""), \
                patch.object(coach, "run_claude_agent", side_effect=fake_agent):
            return coach.run_chat(None, SimpleNamespace(id=1), message, active_workout)

    def test_logged_set_is_returned_to_workout_ui_without_inventing_rpe(self):
        workout = {"id": "active", "exercises": []}

        def fake_agent(**kwargs):
            kwargs["handle_tool"]("log_set", {
                "exercise_name": "Barbell Back Squat", "weight": 65,
                "reps": 5, "set_type": "working",
            }, "call_1")
            return {"text": "Geloggt.", "usage": None}

        result = self.run_chat("65 mal 5", [], fake_agent, workout)
        updated = result["activeWorkoutState"]["exercises"][0]["sets"][0]
        self.assertTrue(updated["completed"])
        self.assertEqual(updated["weight"], 65)
        self.assertIsNone(updated["rpe"])
        self.assertEqual(result["actionsExecuted"][0]["type"], "set_logged")

    def test_start_tool_is_offered_without_a_recognized_confirmation(self):
        offered = {}

        def fake_agent(**kwargs):
            offered["tools"] = [tool["name"] for tool in kwargs["tools"]]
            offered["kwargs"] = kwargs
            return {"text": "Plan steht.", "usage": None}

        result = self.run_chat(
            "Doch schlage das Training wieder vor und starte es dann",
            history(("user", "Was soll ich heute trainieren?"), ("assistant", "Wie lange hast du Zeit?")),
            fake_agent,
        )

        self.assertIn("start_workout_session", offered["tools"])
        self.assertEqual(len(offered["tools"]), len(coach.TOOL_DECLARATIONS))
        self.assertNotIn("force_tool_name", offered["kwargs"])
        self.assertEqual(result["trace"]["toolsOffered"], offered["tools"])

    def test_question_mentioning_workout_start_keeps_the_model_reply(self):
        def fake_agent(**kwargs):
            return {"text": "Vorhin fehlte mir das Tool in diesem Turn.", "usage": None}

        result = self.run_chat(
            "Kannst du sagen, warum du eben nicht das workout starten konntest?",
            history(("assistant", PLAN_REPLY), ("user", "Starte das workout"),
                    ("assistant", "Die Karte ist bereit.")),
            fake_agent,
        )

        self.assertEqual(result["reply"], "Vorhin fehlte mir das Tool in diesem Turn.")
        self.assertIsNone(result["actionExecuted"])

    def test_card_for_earlier_plan_keeps_the_model_reply(self):
        def fake_agent(**kwargs):
            kwargs["handle_tool"]("start_workout_session", WORKOUT_ARGS, "tool_1")
            return {"text": "Hier ist die Karte für den Plan von vorhin.", "usage": None}

        with patch("app.agent.tools.crud.save_user_exercise"):
            result = self.run_chat(
                "Just repeat the tool to start the workout",
                history(("assistant", PLAN_REPLY), ("user", "Danke"),
                        ("assistant", "Gern."), ("user", "Wie lange dauert das?"),
                        ("assistant", "Etwa 65 Minuten.")),
                fake_agent,
            )

        self.assertEqual(result["reply"], "Hier ist die Karte für den Plan von vorhin.")
        self.assertEqual(result["actionExecuted"]["type"], "workout_proposed")
        self.assertEqual(result["toolsUsed"], ["start_workout_session"])


if __name__ == "__main__":
    unittest.main()
