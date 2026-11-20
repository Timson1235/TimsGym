import json
import unittest
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine
from app.auth import current_user
from app.db import get_session
from app.models import User
from app.routers.ai import router
from app import chat_control


class StreamingRouteTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread':False}, poolclass=StaticPool)
        SQLModel.metadata.create_all(self.engine)
        self.app = FastAPI()
        self.app.include_router(router)
        self.user = User(id=1, uid='test-user', email='test@example.com')
        with Session(self.engine) as session:
            session.add(self.user)
            session.commit()
        self.app.dependency_overrides[current_user] = lambda: User(id=1, uid='test-user', email='test@example.com')
        self.request_sessions = []
        def session_dependency():
            with Session(self.engine) as session:
                self.request_sessions.append(session)
                yield session
        self.app.dependency_overrides[get_session] = session_dependency
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()

    def fake_chat(self, session, user, **kwargs):
        self.assertIsNot(session, self.request_sessions[-1])
        kwargs['on_event']({'type':'status','message':'Checking history…'})
        kwargs['on_event']({'type':'delta','text':'Hello'})
        return {'reply':'Hello', 'actionsExecuted':[], 'trace':{
            'requestId':kwargs['request_id'], 'totalMs':1,'steps':[],
        }}

    def test_stream_authorizes_then_emits_and_persists_final_metadata(self):
        with patch('app.routers.ai.coach.run_chat', side_effect=self.fake_chat):
            response = self.client.post('/api/ai/chat', json={'stream':True,'message':'Hi'})
        self.assertEqual(response.status_code, 200)
        self.assertIn('text/event-stream', response.headers['content-type'])
        events = [json.loads(frame[6:]) for frame in response.text.strip().split('\n\n')]
        self.assertEqual([e['type'] for e in events], ['ready','status','delta','final'])
        self.assertFalse(chat_control.interrupt(events[0]['requestId'], 1))
        self.assertEqual(events[-1]['result']['reply'], 'Hello')

    def test_foreign_chat_is_rejected_before_streaming_or_execution(self):
        with patch('app.routers.ai.coach.run_chat') as run:
            response = self.client.post('/api/ai/chat', json={'stream':True,'threadId':'foreign','message':'Hi'})
        self.assertEqual(response.status_code,404)
        run.assert_not_called()

    def test_non_streaming_clients_keep_json_contract(self):
        with patch('app.routers.ai.coach.run_chat', return_value={
            'reply':'Hi','trace':{'requestId':'legacy','totalMs':1,'steps':[]},
        }):
            response = self.client.post('/api/ai/chat', json={'message':'Hi'})
        self.assertEqual(response.json()['reply'],'Hi')
        self.assertIn('application/json',response.headers['content-type'])

    def test_interrupt_is_owner_scoped_and_repeated_clicks_are_safe(self):
        control = chat_control.register('synthetic-interrupt', 1, '1')
        try:
            self.app.dependency_overrides[current_user] = lambda: User(id=2, uid='other', email='other@example.com')
            self.assertEqual(self.client.post('/api/ai/chat/synthetic-interrupt/interrupt').status_code, 404)
            self.assertFalse(control.stopped.is_set())
            self.app.dependency_overrides[current_user] = lambda: User(id=1, uid='owner', email='owner@example.com')
            for _ in range(2):
                self.assertEqual(self.client.post('/api/ai/chat/synthetic-interrupt/interrupt').status_code, 200)
            self.assertTrue(control.stopped.is_set())
        finally:
            chat_control.release('synthetic-interrupt', control)

    def test_concurrent_retry_is_rejected_until_worker_finishes(self):
        control = chat_control.register('synthetic-busy', 1, '1')
        try:
            with patch('app.routers.ai.coach.run_chat') as run:
                response = self.client.post('/api/ai/chat', json={'stream': True, 'message': 'Retry'})
            self.assertEqual(response.status_code, 409)
            run.assert_not_called()
        finally:
            chat_control.release('synthetic-busy', control)

    def test_worker_error_releases_request_for_retry(self):
        with patch('app.routers.ai.coach.run_chat', side_effect=RuntimeError('synthetic')):
            response = self.client.post('/api/ai/chat', json={'stream': True, 'message': 'Hi', 'clientRequestId': 'synthetic-error'})
        self.assertIn('"type":"error"', response.text)
        control = chat_control.register('synthetic-error', 1, '1')
        chat_control.release('synthetic-error', control)

    def test_interrupt_endpoint_reaches_worker_and_stream_still_returns_final_state(self):
        started = Event()
        def running_chat(session, user, **kwargs):
            started.set()
            deadline = time.monotonic() + 3
            while not kwargs['is_cancelled']():
                if time.monotonic() >= deadline:
                    raise AssertionError('Interrupt did not reach the worker')
                time.sleep(0.01)
            return {'reply': 'Stopped', 'status': 'interrupted', 'activeWorkoutState': {'id': 'kept'},
                'trace': {'requestId': kwargs['request_id'], 'totalMs': 1, 'steps': []}}
        with patch('app.routers.ai.coach.run_chat', side_effect=running_chat), ThreadPoolExecutor(max_workers=1) as executor:
            request = executor.submit(self.client.post, '/api/ai/chat', json={
                'stream': True, 'message': 'Synthetic', 'clientRequestId': 'interrupt-worker'})
            self.assertTrue(started.wait(2))
            self.assertEqual(self.client.post('/api/ai/chat/interrupt-worker/interrupt').status_code, 200)
            response = request.result(timeout=4)
        final = json.loads(response.text.strip().split('\n\n')[-1][6:])
        self.assertEqual(final['type'], 'final')
        self.assertEqual(final['result']['status'], 'interrupted')
        self.assertEqual(final['result']['activeWorkoutState']['id'], 'kept')
