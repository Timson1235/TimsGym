import unittest

from sqlalchemy import text
from sqlmodel import Session, create_engine

from app.memory import conversational
from app.models import ChatSession, Message, User


class ChatSessionTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        User.__table__.create(self.engine)
        ChatSession.__table__.create(self.engine)
        Message.__table__.create(self.engine)

    def test_sessions_are_isolated_and_summarized_messages_are_hidden(self):
        with Session(self.engine) as session:
            user = User(uid="user-1", email="test@example.com")
            session.add(user)
            session.commit()
            session.refresh(user)

            first = conversational.ensure_default_chat_session(session, user.id)
            second = conversational.create_chat_session(session, user.id, "Nutrition")
            conversational.write_message(session, user.id, first.id, "user", "Workout question")
            conversational.write_message(session, user.id, second.id, "user", "Nutrition question")

            first_message = conversational.read_message_history(session, user.id, first.id)[0]
            first_message.summary_id = "summary-1"
            session.add(first_message)
            session.commit()

            self.assertEqual(conversational.read_message_history(session, user.id, first.id), [])
            visible_second = conversational.read_message_history(session, user.id, second.id)
            self.assertEqual([item.content for item in visible_second], ["Nutrition question"])
            self.assertEqual(len(conversational.list_chat_sessions(session, user.id)), 2)

    def test_first_message_names_a_new_chat(self):
        with Session(self.engine) as session:
            user = User(uid="user-2", email="test@example.com")
            session.add(user)
            session.commit()
            session.refresh(user)
            chat = conversational.create_chat_session(session, user.id)

            conversational.touch_chat_session(
                session, chat, "Help me plan nutrition around evening workouts",
            )
            title = session.exec(text("SELECT title FROM chat_sessions WHERE id=:id"), params={"id": chat.id}).one()[0]
            self.assertEqual(title, "Help me plan nutrition around evening workouts")


if __name__ == "__main__":
    unittest.main()
