import json
import unittest
from unittest.mock import patch

from app.agent.claude_provider import run_claude_agent
from app.agent.tools import TOOL_DECLARATIONS


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class ClaudeProviderTests(unittest.TestCase):
    def test_full_coach_toolset_stays_within_strict_optional_budget(self):
        with patch("app.agent.claude_provider._request_json", return_value={
            "content": [{"type": "text", "text": "OK"}],
        }) as request:
            run_claude_agent(api_key="test", model="test", system_instruction="test",
                             messages=[{"role": "user", "content": "test"}],
                             tools=TOOL_DECLARATIONS, handle_tool=lambda *args: "done")
        payload = json.loads(request.call_args.args[0].data)
        self.assertEqual(len(payload["tools"]), len(TOOL_DECLARATIONS))
        self.assertTrue(all(not t["strict"] for t in payload["tools"]))

    def test_multiple_tools_can_run_sequentially(self):
        requests = []
        responses = iter([
            FakeResponse({"content": [{
                "type": "tool_use",
                "id": "tool_1",
                "name": "delete_workout",
                "input": {"searchOrId": "empty restart"},
            }]}),
            FakeResponse({"content": [{
                "type": "tool_use",
                "id": "tool_2",
                "name": "log_workout",
                "input": {"title": "Completed workout", "exercises": []},
            }]}),
            FakeResponse({"stop_reason": "end_turn", "content": [{"type": "text", "text": "Gelöscht und eingetragen."}]}),
        ])

        def fake_urlopen(request, timeout, context):
            requests.append(json.loads(request.data.decode("utf-8")))
            self.assertEqual(timeout, 45)
            self.assertIsNotNone(context)
            return next(responses)

        calls = []
        with patch("app.agent.claude_provider.urlopen", side_effect=fake_urlopen):
            result = run_claude_agent(
                api_key="test-key",
                model="claude-sonnet-5-5",
                system_instruction="System",
                messages=[{"role": "user", "content": "Lösche den leeren Eintrag und trage das Workout ein."}],
                tools=[
                    {
                        "name": "delete_workout",
                        "description": "Delete workout",
                        "parameters": {
                            "type": "OBJECT",
                            "properties": {"searchOrId": {"type": "STRING"}},
                            "required": ["searchOrId"],
                        },
                    },
                    {
                        "name": "log_workout",
                        "description": "Log workout",
                        "parameters": {
                            "type": "OBJECT",
                            "properties": {"title": {"type": "STRING"}},
                            "required": ["title"],
                        },
                    },
                ],
                handle_tool=lambda name, args, call_id: calls.append(
                    (name, args, call_id)
                ) or "done",
            )

        self.assertEqual(result["text"], "Gelöscht und eingetragen.")
        self.assertEqual(result["usage"]["provider"], "claude")
        self.assertEqual(
            [step["name"] for step in result["traceSteps"]],
            ["Claude round 1", "Claude round 2", "Claude round 3"],
        )
        self.assertEqual(
            [step["toolCalls"] for step in result["traceSteps"]],
            [["delete_workout"], ["log_workout"], []],
        )
        self.assertEqual(result["traceSteps"][2]["stopReason"], "end_turn")
        self.assertEqual(calls, [
            ("delete_workout", {"searchOrId": "empty restart"}, "tool_1"),
            ("log_workout", {"title": "Completed workout", "exercises": []}, "tool_2"),
        ])
        self.assertNotIn("tool_choice", requests[0])
        self.assertEqual(requests[0]["tools"][0]["input_schema"]["type"], "object")
        self.assertFalse(requests[0]["tools"][0]["input_schema"]["additionalProperties"])
        self.assertEqual(requests[1]["messages"][-1]["content"][0]["type"], "tool_result")
        self.assertEqual(requests[2]["messages"][-1]["content"][0]["tool_use_id"], "tool_2")


if __name__ == "__main__":
    unittest.main()
