import unittest

from sqlmodel import Session, create_engine, select

from app.models import AIRequestMetric, User
from app.observability import read_user_usage_summary, update_round_trip_ms, write_ai_request_metric


class ObservabilityTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        User.__table__.create(self.engine)
        AIRequestMetric.__table__.create(self.engine)

    def test_request_trace_is_scoped_to_user_and_roundtrip_can_be_added(self):
        with Session(self.engine) as session:
            user = User(uid="firebase-user", email="test@example.com")
            session.add(user)
            session.commit()
            session.refresh(user)

            trace = {
                "requestId": "request-123",
                "totalMs": 6400,
                "agentSteps": 2,
                "modelMs": 6100,
                "toolMs": 120,
                "contextMs": 80,
                "persistenceMs": 40,
                "slowestStep": {
                    "kind": "llm",
                    "name": "Claude round 1",
                    "durationMs": 5000,
                },
                "steps": [{"kind": "llm", "name": "Claude round 1", "durationMs": 5000}],
            }
            usage = {
                "provider": "claude",
                "model": "claude-sonnet-5-5",
                "inputTokens": 1000,
                "outputTokens": 100,
                "totalTokens": 1100,
                "estimatedCostUsd": 0.003,
            }

            write_ai_request_metric(
                session,
                user_id=user.id,
                thread_id=str(user.id),
                trace=trace,
                usage=usage,
                tools_used=["get_exercise_history"],
            )
            updated = update_round_trip_ms(
                session,
                user_id=user.id,
                request_id="request-123",
                round_trip_ms=6700,
            )

            metric = session.exec(select(AIRequestMetric)).one()
            self.assertTrue(updated)
            self.assertEqual(metric.user_id, user.id)
            self.assertEqual(metric.round_trip_ms, 6700)
            self.assertEqual(metric.agent_steps, 2)
            self.assertEqual(metric.tools_used, ["get_exercise_history"])
            self.assertEqual(metric.slowest_step_name, "Claude round 1")
            self.assertFalse(hasattr(metric, "prompt"))

    def test_usage_summary_is_persistent_and_scoped_to_one_user(self):
        with Session(self.engine) as session:
            first = User(uid="first", email="first@example.com")
            second = User(uid="second", email="second@example.com")
            session.add(first)
            session.add(second)
            session.commit()
            session.refresh(first)
            session.refresh(second)

            for request_id, user_id, tokens, cost in [
                ("first-1", first.id, 1200, 0.012),
                ("first-2", first.id, 800, 0.008),
                ("second-1", second.id, 9999, 9.99),
            ]:
                write_ai_request_metric(
                    session,
                    user_id=user_id,
                    thread_id="thread",
                    trace={"requestId": request_id, "totalMs": 1, "steps": []},
                    usage={
                        "provider": "claude", "model": "test",
                        "inputTokens": tokens - 100, "outputTokens": 100,
                        "totalTokens": tokens, "estimatedCostUsd": cost,
                    },
                )

            summary = read_user_usage_summary(session, user_id=first.id)
            self.assertEqual(summary["allTime"]["requests"], 2)
            self.assertEqual(summary["allTime"]["totalTokens"], 2000)
            self.assertAlmostEqual(summary["allTime"]["estimatedCostUsd"], 0.02)
            self.assertEqual(summary["currentMonth"]["totalTokens"], 2000)


if __name__ == "__main__":
    unittest.main()
