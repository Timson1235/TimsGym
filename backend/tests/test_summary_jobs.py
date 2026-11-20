import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import update
from sqlmodel import SQLModel, Session, create_engine, select

from app.memory import conversational, summary, summary_jobs as jobs
from app.models import ConversationSummary, Message, SummaryJob

GENERATED = dict(description='User preferences', summary='Prefers morning training.', usage=None)


class SummaryJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.url = f'sqlite:///{Path(self.tmp.name) / "queue.db"}'
        self.engine = create_engine(self.url)
        SQLModel.metadata.create_all(self.engine)
        self.provider = patch.object(jobs.settings, 'CLAUDE_API_KEY', 'test')
        self.provider.start()
        self.ids = self.add_messages(6)

    def tearDown(self):
        self.provider.stop()
        self.engine.dispose()
        self.tmp.cleanup()

    def add_messages(self, count, user=1, thread='chat', content='User fact. ' * 200):
        ids = []
        with Session(self.engine) as session:
            for i in range(count):
                row = Message(user_id=user,thread_id=thread,role='user' if i % 2 == 0 else 'assistant',content=content)
                session.add(row)
                session.flush()
                ids.append(row.id)
            session.commit()
        return ids

    def enqueue(self, through=None, user=1, thread='chat'):
        with Session(self.engine) as session:
            jobs.enqueue_through(session,user,thread,through or self.ids[1])

    def claim(self):
        with Session(self.engine) as session: return jobs.claim_next(session)

    def job(self, user=1, thread='chat'):
        with Session(self.engine) as session: return session.get(SummaryJob,jobs._job_id(user,thread))

    def test_queue_is_durable_coalesced_and_keeps_last_two_exchanges(self):
        with Session(self.engine) as session:
            self.assertTrue(jobs.enqueue_if_needed(session,1,'chat'))
            self.assertTrue(jobs.enqueue_if_needed(session,1,'chat'))
            self.assertEqual(len(session.exec(select(SummaryJob)).all()),1)
        self.assertEqual(self.job().requested_through_id,self.ids[1])
        self.engine.dispose()
        replacement = create_engine(self.url)
        with patch.object(summary,'generate_summary',return_value=GENERATED):
            self.assertTrue(jobs.run_once(replacement))
        with Session(replacement) as session:
            pending = conversational.read_recent_messages(session,1,'chat',limit=200)
            self.assertEqual([m.id for m in pending],self.ids[2:])
            self.assertEqual(len(conversational.read_message_history(session,1,'chat')),6)
        replacement.dispose()
        self.assertEqual(self.job().status,'completed')

    def test_claim_is_exclusive_and_stale_worker_cannot_publish(self):
        self.enqueue()
        old = self.claim()
        self.assertIsNone(self.claim())
        with Session(self.engine) as session:
            session.execute(update(SummaryJob).values(lease_until=0))
            session.commit()
        new = self.claim()
        self.assertNotEqual(old.token,new.token)
        with patch.object(summary,'generate_summary',return_value=GENERATED):
            self.assertFalse(jobs.process_claim(self.engine,old))
            self.assertTrue(jobs.process_claim(self.engine,new))
            self.assertFalse(jobs.process_claim(self.engine,new))
        with Session(self.engine) as session:
            self.assertEqual(len(session.exec(select(ConversationSummary)).all()),1)

    def test_new_turns_during_generation_are_not_archived_by_old_job(self):
        self.enqueue()
        claim = self.claim()
        added = []
        def generate(*args):
            added.extend(self.add_messages(2))
            self.enqueue(self.ids[-1])
            return GENERATED
        with patch.object(summary,'generate_summary',side_effect=generate):
            self.assertTrue(jobs.process_claim(self.engine,claim))
        self.assertEqual(self.job().status,'pending')
        self.assertEqual(self.job().completed_through_id,self.ids[1])
        with Session(self.engine) as session:
            self.assertTrue(all(session.get(Message,i).summary_id is None for i in added))
        with patch.object(summary,'generate_summary',return_value=GENERATED) as generate:
            jobs.run_once(self.engine)
            self.assertIn('Prefers morning training',generate.call_args.args[1])
        self.assertEqual(self.job().completed_through_id,self.ids[-1])

    def test_retries_back_off_then_stop_without_hiding_messages(self):
        self.enqueue()
        with patch.object(summary,'generate_summary',side_effect=RuntimeError('provider unavailable')) as generate:
            for attempt in range(jobs.MAX_ATTEMPTS):
                self.assertTrue(jobs.run_once(self.engine))
                self.assertIsNone(self.claim())
                if attempt < jobs.MAX_ATTEMPTS - 1:
                    with Session(self.engine) as session:
                        session.execute(update(SummaryJob).values(available_at=0))
                        session.commit()
            self.assertEqual(generate.call_count,jobs.MAX_ATTEMPTS)
        self.assertEqual(self.job().status,'failed')
        with Session(self.engine) as session:
            self.assertEqual(len(conversational.read_recent_messages(session,1,'chat',200)),6)
        self.enqueue()  # repeating the same request must not restart failed work
        self.assertEqual(self.job().status,'failed')
        self.enqueue(self.ids[2])
        self.assertEqual(self.job().status,'pending')

    def test_deleted_chat_cannot_be_resurrected_by_running_worker(self):
        self.enqueue()
        claim = self.claim()
        def generate(*args):
            with Session(self.engine) as session: conversational.clear_message_history(session,1,'chat')
            return GENERATED
        with patch.object(summary,'generate_summary',side_effect=generate):
            self.assertFalse(jobs.process_claim(self.engine,claim))
        self.assertIsNone(self.job())
        with Session(self.engine) as session:
            self.assertEqual(session.exec(select(ConversationSummary)).all(),[])
            self.assertEqual(session.exec(select(Message)).all(),[])

    def test_accounts_and_chat_context_are_isolated(self):
        other = self.add_messages(6,user=2,thread='chat',content='Other account')
        self.enqueue()
        with patch.object(summary,'generate_summary',return_value=GENERATED): jobs.run_once(self.engine)
        with Session(self.engine) as session:
            tail, memory = summary.read_coach_context(session,1,'chat')
            self.assertEqual([m.id for m in tail],self.ids[2:])
            self.assertIn('Prefers morning training',memory)
            other_tail, other_memory = summary.read_coach_context(session,2,'chat')
            self.assertEqual([m.id for m in other_tail],other)
            self.assertEqual(other_memory,'')

    def test_large_batches_only_archive_the_messages_actually_sent(self):
        self.enqueue(self.ids[-1])
        with patch.object(summary,'generate_summary',return_value=GENERATED) as generate:
            jobs.run_once(self.engine)
            transcript = generate.call_args.args[0]
        self.assertLessEqual(len(transcript),jobs.BATCH_CHARS)
        with Session(self.engine) as session:
            archived = session.exec(select(Message).where(Message.summary_id != None)).all()
            self.assertEqual(len(archived),transcript.count('[USER]') + transcript.count('[ASSISTANT]'))
            self.assertEqual(self.job().status,'pending')

    def test_oversized_message_is_retained_in_full_instead_of_silently_truncated(self):
        ids = self.add_messages(1,thread='large',content='x' * (jobs.MAX_SINGLE_MESSAGE_CHARS + 1))
        self.enqueue(ids[0],thread='large')
        with patch.object(summary,'generate_summary') as generate:
            jobs.run_once(self.engine)
            generate.assert_not_called()
        with Session(self.engine) as session:
            self.assertIsNone(session.get(Message,ids[0]).summary_id)

    def test_worker_lifecycle_and_http_reply_do_not_wait_for_summary_provider(self):
        import threading
        import time
        from fastapi.testclient import TestClient
        from app import main
        from app.agent import coach
        from app.auth import current_user
        from app.db import get_session
        from app.models import ChatSession, User
        started, release = threading.Event(), threading.Event()
        with Session(self.engine) as session:
            session.add(User(id=1,uid='summary-test',email='test@example.com'))
            session.add(ChatSession(id='chat',user_id=1,title='Test'))
            session.commit()
        self.enqueue()
        def slow_summary(*args):
            started.set()
            if not release.wait(5): raise TimeoutError('Test provider was not released')
            return GENERATED
        def sessions():
            with Session(self.engine) as session: yield session
        overrides = dict(main.app.dependency_overrides)
        main.app.dependency_overrides[current_user] = lambda: User(id=1,uid='summary-test',email='test@example.com')
        main.app.dependency_overrides[get_session] = sessions
        try:
            with patch.object(main,'engine',self.engine), patch.object(main,'ensure_observability_schema'), \
                    patch.object(main.settings,'SUMMARY_WORKER_ENABLED',True), \
                    patch.object(summary,'generate_summary',side_effect=slow_summary), \
                    patch.object(coach,'run_claude_agent',return_value=dict(text='Reply ready',usage=None)), \
                    TestClient(main.app) as client:
                self.assertTrue(started.wait(2),'Worker should start pending jobs on app startup')
                try:
                    response = client.post('/api/ai/chat',json=dict(message='What should I train?',threadId='chat',stream=True))
                    self.assertEqual(response.status_code,200)
                    self.assertIn('Reply ready',response.text)
                    events = [json.loads(frame[6:]) for frame in response.text.strip().split('\n\n')]
                    self.assertEqual(events[-1]['type'],'final')
                    self.assertTrue(events[-1]['result']['summaryQueued'])
                    self.assertFalse(release.is_set(),'Response must finish while summary generation is blocked')
                finally:
                    release.set()
                deadline = time.monotonic() + 2
                while self.job().completed_through_id < self.ids[1] and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertEqual(self.job().completed_through_id,self.ids[1])
            self.assertFalse(main.app.state.summary_worker.thread.is_alive())
        finally:
            release.set()
            main.app.dependency_overrides.clear()
            main.app.dependency_overrides.update(overrides)

    def test_successful_background_usage_is_counted_separately(self):
        from app.models import AIRequestMetric
        self.enqueue()
        generated = {**GENERATED,'usage':dict(provider='claude',model='test',inputTokens=100,outputTokens=20,totalTokens=120,estimatedCostUsd=0.001)}
        with patch.object(summary,'generate_summary',return_value=generated): jobs.run_once(self.engine)
        with Session(self.engine) as session:
            metric = session.exec(select(AIRequestMetric)).one()
            self.assertTrue(metric.request_id.startswith('summary:'))
            self.assertEqual(metric.total_tokens,120)
            self.assertEqual(metric.user_id,1)

    def test_missing_queue_table_keeps_legacy_chat_readable(self):
        with Session(self.engine) as session:
            SummaryJob.__table__.drop(self.engine)
            tail, memory = summary.read_coach_context(session,1,'chat')
            self.assertEqual([m.id for m in tail],self.ids)
            self.assertEqual(memory,'')

    def test_crashed_workers_eventually_stop_retrying(self):
        self.enqueue()
        claim = self.claim()
        with Session(self.engine) as session:
            session.execute(update(SummaryJob).values(lease_until=0,attempts=jobs.MAX_ATTEMPTS))
            session.commit()
        self.assertIsNone(self.claim())
        self.assertEqual(self.job().status,'failed')
        with patch.object(summary,'generate_summary',return_value=GENERATED):
            self.assertFalse(jobs.process_claim(self.engine,claim))

    def test_context_remains_bounded_when_compaction_is_delayed(self):
        self.add_messages(4,thread='long',content='x' * 10000)
        with Session(self.engine) as session:
            tail, memory = summary.read_coach_context(session,1,'long')
            self.assertLessEqual(sum(len(m.content) for m in tail),16100)
            self.assertIn('awaiting background',memory)
            self.assertEqual(len(conversational.read_message_history(session,1,'long')),4)

    def test_context_snapshot_survives_worker_publish_between_reads(self):
        self.enqueue()
        with patch.object(summary,'generate_summary',return_value=GENERATED): jobs.run_once(self.engine)
        previous_id = self.job().summary_id
        self.enqueue(self.ids[3])
        claim = self.claim()
        with Session(self.engine) as session:
            original_get = session.get
            published = False
            def publish_before_checkpoint_read(model, identity, **kwargs):
                nonlocal published
                if model is ConversationSummary and identity == previous_id and not published:
                    published = True
                    with patch.object(summary,'generate_summary',return_value={**GENERATED,'summary':'New checkpoint'}):
                        jobs.process_claim(self.engine,claim)
                return original_get(model,identity,**kwargs)
            with patch.object(session,'get',side_effect=publish_before_checkpoint_read):
                tail, memory = summary.read_coach_context(session,1,'chat')
            self.assertTrue(published)
            self.assertEqual([m.id for m in tail],self.ids[2:])
            self.assertIn('Prefers morning training',memory)
            self.assertNotIn('New checkpoint',memory)
