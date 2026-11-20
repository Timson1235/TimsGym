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
    """The coach offers a small core, discovers tools and preserves model replies."""

    def run_chat(self, message, recent_messages, fake_agent, active_workout=None):
        database = {
            "profile": {"name": "Tim"},
            "exercises": [{"id": "squat", "name": "Barbell Back Squat", "category": "Legs"}],
            "workouts": [],
        }
        with patch.object(coach.settings, "CLAUDE_API_KEY", "test-key"), \
                patch.object(coach.crud, "get_user_database_state", return_value=database), \
                patch.object(coach.summ, "read_coach_context", return_value=(recent_messages, "")), \
                patch.object(coach.memory, "write_message"), \
                patch.object(coach.memory, "write_tool_log"), \
                patch.object(coach.context, "should_summarize", return_value=False), \
                patch.object(coach.summary_jobs, "enqueue_if_needed", return_value=False), \
                patch.object(coach, "run_claude_agent", side_effect=fake_agent):
            return coach.run_chat(None, SimpleNamespace(id=1), message, active_workout)

    def test_failed_final_generation_does_not_replay_a_mutation_on_gemini(self):
        workout = {"id": "active", "exercises": []}
        def failing_agent(**kwargs):
            kwargs["handle_tool"]("log_set", {
                "exercise_name": "Barbell Back Squat", "weight": 65,
                "reps": 5, "set_type": "working",
            }, "call_1")
            raise RuntimeError("Connection lost after tool execution")
        with patch.object(coach, "_generate_with_retry") as fallback:
            result = self.run_chat("65 mal 5", [], failing_agent, workout)
        fallback.assert_not_called()
        self.assertEqual(len(result["actionsExecuted"]), 1)
        self.assertEqual(result["actionsExecuted"][0]["type"], "set_logged")

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

    def test_timeout_fallback_records_the_reason(self):
        def timed_out(**kwargs):
            raise TimeoutError("The read operation timed out")
        response = SimpleNamespace(function_calls=[], text="Fallback reply", usage_metadata=None)
        with patch.object(coach, "_client", object()), \
                patch.object(coach, "_generate_with_retry", return_value=response):
            result = self.run_chat("Question", [], timed_out)
        self.assertEqual(result["trace"]["providerFallback"], {
            "from": "claude", "to": "gemini", "reason": "timeout",
        })

    def test_complete_proposal_can_include_start_button_without_prior_confirmation(self):
        def proposing_agent(**kwargs):
            kwargs["handle_tool"]("discover_tools", {"names": ["start_workout_session"]}, "discover")
            kwargs["get_tools"]()
            kwargs["handle_tool"]("start_workout_session", WORKOUT_ARGS, "proposal")
            return {"text": "Hier ist dein Vorschlag. Klicke Workout starten.", "usage": None}
        result = self.run_chat("Schlage mir ein Workout vor", [], proposing_agent)
        self.assertEqual(result["actionExecuted"]["type"], "workout_proposed")
        self.assertEqual(result["actionExecuted"]["data"]["title"], WORKOUT_ARGS["title"])
        self.assertIsNone(result["activeWorkoutState"])
        self.assertFalse(result["actionExecuted"]["data"]["isCompleted"])

    def test_general_requests_offer_only_discovery_regardless_of_wording(self):
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

        self.assertEqual(offered["tools"], ["discover_tools"])
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
            kwargs["handle_tool"]("discover_tools", {"names": ["start_workout_session"]}, "discover")
            kwargs["get_tools"]()
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
        self.assertEqual(result["toolsUsed"], ["discover_tools", "start_workout_session"])


if __name__ == "__main__":
    unittest.main()
