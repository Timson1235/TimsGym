import unittest
from unittest.mock import patch

from app.agent.tools import HANDLERS, TOOL_DECLARATIONS


class MemoryToolTests(unittest.TestCase):
    def test_memory_tools_are_declared_and_connected(self):
        declarations = {tool["name"]: tool for tool in TOOL_DECLARATIONS}
        self.assertIn("save_personal_memory", declarations)
        self.assertIn("remove_personal_memory", declarations)
        self.assertIn("save_personal_memory", HANDLERS)
        self.assertIn("remove_personal_memory", HANDLERS)
        self.assertIn("explicitly asks", declarations["save_personal_memory"]["description"])

    def test_save_memory_updates_profile(self):
        database = {"profile": {"personalMemories": []}}
        with patch("app.agent.tools.crud.update_user_profile") as update_profile:
            result = HANDLERS["save_personal_memory"](
                object(),
                7,
                database,
                {"memory": "Prefers compound exercises"},
            )

        self.assertEqual(result, {
            "type": "memory_saved",
            "data": "Prefers compound exercises",
        })
        self.assertEqual(database["profile"]["personalMemories"], ["Prefers compound exercises"])
        update_profile.assert_called_once_with(
            unittest.mock.ANY,
            7,
            {"personalMemories": ["Prefers compound exercises"]},
        )


if __name__ == "__main__":
    unittest.main()
