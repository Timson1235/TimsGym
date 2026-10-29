import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine

from app import auth
from app.config import settings
from app.db import get_session
from app.main import app_access
from app.routers.ai import router as ai_router
from app.routers.db import router as db_router

OWNER = 'synthetic-owner-uid'


class PrivateAccessTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.engine=create_engine(f'sqlite:///{Path(self.tmp.name)/"access.db"}')
        SQLModel.metadata.create_all(self.engine)
        self.app=FastAPI()
        self.app.include_router(ai_router)
        self.app.include_router(db_router)
        self.app.add_api_route('/api/access',app_access,methods=['GET'])
        def sessions():
            with Session(self.engine) as session:yield session
        self.app.dependency_overrides[get_session]=sessions
        self.client=TestClient(self.app)
        self.policy=patch.multiple(settings,APP_ALLOWED_UID=OWNER,TRACE_ADMIN_UID=OWNER)
        self.policy.start()
        self.token=patch.object(auth.google_id_token,'verify_firebase_token',return_value=self.claims(OWNER))
        self.verify=self.token.start()
        self.headers={'Authorization':'Bearer synthetic-signed-token'}

    def claims(self,uid):
        return {'sub':uid,'user_id':uid,'email':'synthetic@example.com','iss':f'https://securetoken.google.com/{settings.FIREBASE_PROJECT_ID}'}

    def tearDown(self):
        self.client.close()
        self.token.stop()
        self.policy.stop()
        self.engine.dispose()
        self.tmp.cleanup()

    def test_owner_can_use_app_and_inspect_own_traces(self):
        permission=self.client.get('/api/access',headers=self.headers)
        self.assertEqual(permission.status_code,200)
        self.assertEqual(permission.json(),{'canUseApp':True,'canInspectTraces':True})
        self.assertEqual(permission.headers['cache-control'],'no-store')
        self.assertEqual(self.client.get('/api/db',headers=self.headers).status_code,200)
        self.assertEqual(self.client.get('/api/ai/traces',headers=self.headers).status_code,200)

    def test_other_account_is_rejected_before_bootstrap_tools_or_trace_reads(self):
        self.verify.return_value=self.claims('someone-else')
        routes=[('GET','/api/access',None),('GET','/api/db',None),('POST','/api/db/workout',{}),
                ('POST','/api/db/reset',{}),('GET','/api/ai/history',None),('GET','/api/ai/sessions',None),
                ('POST','/api/ai/chat',{'message':'hello','stream':True,'uid':OWNER}),
                ('GET','/api/ai/traces',None),('GET','/api/ai/traces/example?payloads=true',None),
                ('GET','/api/ai/traces/example/payload/payload',None)]
        with patch.object(auth.crud,'get_or_create_user') as bootstrap,patch('app.routers.ai.coach.run_chat') as run:
            for method,path,body in routes:
                with self.subTest(path=path):
                    response=self.client.request(method,path,headers=self.headers,json=body)
                    self.assertEqual(response.status_code,403)
            bootstrap.assert_not_called()
            run.assert_not_called()

    def test_missing_or_bad_tokens_and_wrong_issuer_are_rejected(self):
        self.assertEqual(self.client.get('/api/access').status_code,401)
        self.verify.side_effect=ValueError('invalid signature')
        self.assertEqual(self.client.get('/api/access',headers=self.headers).status_code,401)
        self.verify.side_effect=None
        self.verify.return_value={**self.claims(OWNER),'iss':'https://example.com'}
        self.assertEqual(self.client.get('/api/access',headers=self.headers).status_code,401)

    def test_empty_app_policy_denies_everyone(self):
        with patch.object(settings,'APP_ALLOWED_UID',''),patch.object(auth.crud,'get_or_create_user') as bootstrap:
            self.assertEqual(self.client.get('/api/access',headers=self.headers).status_code,403)
            bootstrap.assert_not_called()

    def test_subject_is_authoritative_and_mismatched_identity_is_rejected(self):
        self.verify.return_value={**self.claims('someone-else'),'user_id':OWNER}
        with patch.object(auth.crud,'get_or_create_user') as bootstrap:
            self.assertEqual(self.client.get('/api/access',headers=self.headers).status_code,401)
            bootstrap.assert_not_called()

    def test_admin_policy_is_independent_and_fails_closed(self):
        for administrator in ('','another-admin'):
            with self.subTest(administrator=administrator),patch.object(settings,'TRACE_ADMIN_UID',administrator):
                self.assertEqual(self.client.get('/api/access',headers=self.headers).json()['canInspectTraces'],False)
                for path in ('/api/ai/traces','/api/ai/traces/example?payloads=true','/api/ai/traces/example/payload/payload'):
                    self.assertEqual(self.client.get(path,headers=self.headers).status_code,403)
