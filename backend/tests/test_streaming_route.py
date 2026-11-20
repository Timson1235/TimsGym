import json
import unittest
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine
from app.auth import current_user
from app.db import get_session
from app.models import User
from app.routers.ai import router


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
        self.assertEqual([e['type'] for e in events], ['status','delta','final'])
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
