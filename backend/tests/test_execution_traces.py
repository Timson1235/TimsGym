import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.genai import types
from sqlmodel import SQLModel, Session, create_engine, select

from app.agent.tool_registry import REGISTRY
from app import tracing
from app.agent import coach, claude_provider
from app.auth import current_user
from app.db import get_session
from app.models import AgentTrace, AgentSpan, AgentTracePayload, User
from app.routers.ai import router


class ExecutionTraceTests(unittest.TestCase):
    def setUp(self):
        policy = patch.multiple(tracing.settings, APP_ALLOWED_UID='test', TRACE_ADMIN_UID='test')
        policy.start()
        self.addCleanup(policy.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = create_engine(f'sqlite:///{Path(self.tmp.name)/"traces.db"}')
        SQLModel.metadata.create_all(self.engine)
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[current_user] = lambda: User(id=1,uid='test',email='test@example.com')
        def sessions():
            with Session(self.engine) as session: yield session
        self.app.dependency_overrides[get_session] = sessions
        with Session(self.engine) as session:
            session.add(User(id=1,uid='test',email='test@example.com'))
            session.commit()
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def detail(self,trace_id):
        with Session(self.engine) as session: return tracing.read_trace(session,1,trace_id,True)

    def test_payloads_are_complete_snapshots_redacted_and_outside_agent_tools(self):
        source = {'messages':[{'role':'user','content':'x'*12000}], 'api_key':'private-key',
                  'authorization':'Bearer private-token', 'nested':{'text':'Bearer abc.def.sig'},
                  'thinking':'hidden', 'content':[{'type':'thinking','thinking':'private reasoning'}]}
        with tracing.request_trace(self.engine,'snapshot',1,'chat'):
            with tracing.Span('model_round','Round',source) as span:
                source['messages'].append({'role':'assistant','content':'Later mutation'})
                span.output({'text':'Done','usage':{'input_tokens':100}})
        result = self.detail('snapshot')
        payload = result['payloads'][result['spans'][0]['input_payload_id']]
        self.assertEqual(len(payload['messages']),1)
        self.assertEqual(len(payload['messages'][0]['content']),12000)
        self.assertEqual(payload['api_key'],'[REDACTED]')
        self.assertEqual(payload['nested']['text'],'Bearer [REDACTED]')
        self.assertNotIn('private reasoning',json.dumps(payload))
        self.assertEqual(len(REGISTRY),18)
        self.assertFalse(any('trace' in name for name in REGISTRY))

    def test_model_rounds_include_raw_tool_result_and_actual_feedback(self):
        database = {'profile':{'name':'Test'},'exercises':[{'id':'squat','name':'Squat','category':'Legs'}],'workouts':[]}
        responses = [
            {'content':[{'type':'tool_use','id':'discovery','name':'discover_tools','input':{'names':['get_exercise_history']}}], 'stop_reason':'tool_use'},
            {'content':[{'type':'tool_use','id':'call-1','name':'get_exercise_history','input':{'exercise_id':'squat'}}],
             'usage':{'input_tokens':100,'output_tokens':20},'stop_reason':'tool_use'},
            {'content':[{'type':'text','text':'No history yet'}],'usage':{'input_tokens':150,'output_tokens':10},'stop_reason':'end_turn'},
        ]
        with tracing.request_trace(self.engine,'loop',1,'chat'), \
                patch.object(coach.settings,'CLAUDE_API_KEY','synthetic-key'), \
                patch.object(coach.crud,'get_user_database_state',return_value=database), \
                patch.object(coach.summ,'read_coach_context',return_value=([],'')), \
                patch.object(coach.memory,'write_message'),patch.object(coach.memory,'write_tool_log'), \
                patch.object(coach.summary_jobs,'enqueue_if_needed',return_value=False), \
                patch.object(claude_provider,'_request_json',side_effect=responses):
            coach.run_chat(None,SimpleNamespace(id=1),'What did I squat?',None)
        result = self.detail('loop')
        rounds = [s for s in result['spans'] if s['kind']=='model_round']
        tool = next(s for s in result['spans'] if s['kind']=='tool' and s['name']=='get_exercise_history')
        self.assertEqual(len(rounds),3)
        self.assertEqual(tool['parent_span_id'],rounds[1]['id'])
        output = result['payloads'][tool['output_payload_id']]
        self.assertEqual(output['result']['status'],'no_history')
        first = result['payloads'][rounds[0]['input_payload_id']]
        second = result['payloads'][rounds[2]['input_payload_id']]
        self.assertEqual(len(first['messages']),1)
        self.assertEqual(second['messages'][-1]['content'][0]['content'],output['feedbackToModel'])
        self.assertEqual(result['payloads'][rounds[1]['output_payload_id']]['usage']['input_tokens'],100)

    def test_gemini_retries_have_individual_attempt_spans(self):
        client = Mock()
        client.models.generate_content.side_effect = [RuntimeError('503 UNAVAILABLE'),types.GenerateContentResponse()]
        with tracing.request_trace(self.engine,'retry',1,'chat'),patch.object(coach.time,'sleep'):
            coach._generate_with_retry(client,'primary',[],None)
        spans=self.detail('retry')['spans']
        self.assertEqual([s['status'] for s in spans],['error','completed'])
        self.assertEqual([s['kind'] for s in spans],['provider_attempt']*2)

    def test_authentication_scopes_list_details_export_and_payloads(self):
        for user,trace_id in [(1,'own'),(2,'foreign')]:
            with tracing.request_trace(self.engine,trace_id,user,'chat'):
                with tracing.Span('context','Context',{'content':'synthetic'}) as span: span.output({'ok':True})
        traces = self.client.get('/api/ai/traces').json()['traces']
        self.assertEqual([t['id'] for t in traces],['own'])
        self.assertEqual(self.client.get('/api/ai/traces/foreign?payloads=true').status_code,404)
        own = self.client.get('/api/ai/traces/own').json()
        self.assertNotIn('payloads',own)
        exported = self.client.get('/api/ai/traces/own?payloads=true')
        self.assertTrue(exported.json()['payloads'])
        self.assertEqual(exported.headers['cache-control'],'no-store')
        foreign = self.detail_for_user(2,'foreign')
        pid=foreign['spans'][0]['input_payload_id']
        self.assertEqual(self.client.get(f'/api/ai/traces/own/payload/{pid}').status_code,404)
        self.app.dependency_overrides.pop(current_user)
        self.assertIn(self.client.get('/api/ai/traces').status_code,(401,403))

    def detail_for_user(self,user,trace_id):
        with Session(self.engine) as session:return tracing.read_trace(session,user,trace_id,True)

    def test_live_spans_are_visible_before_the_model_request_finishes(self):
        started,release=threading.Event(),threading.Event()
        def slow_coach(session,user,**kwargs):
            with tracing.Span('model_round','Blocked model',{'prompt':'Synthetic live prompt'}) as span:
                span.progress({'streamedText':'Partial answer'})
                started.set()
                if not release.wait(5):raise TimeoutError('Test not released')
                span.output({'text':'Finished'})
            return {'reply':'Finished','trace':{'requestId':kwargs['request_id'],'totalMs':1,'steps':[]}}
        try:
            with patch.object(coach,'run_chat',side_effect=slow_coach),ThreadPoolExecutor(max_workers=1) as pool:
                future=pool.submit(self.client.post,'/api/ai/chat',json={'message':'Synthetic request'})
                try:
                    self.assertTrue(started.wait(2))
                    listed=self.client.get('/api/ai/traces').json()['traces']
                    self.assertEqual(listed[0]['status'],'running')
                    trace_id=listed[0]['id']
                    detail=self.client.get(f'/api/ai/traces/{trace_id}').json()
                    model=next(s for s in detail['spans'] if s['kind']=='model_round')
                    self.assertEqual(model['status'],'running')
                    partial=self.client.get(f'/api/ai/traces/{trace_id}/payload/{model["output_payload_id"]}').json()
                    self.assertEqual(partial['data']['streamedText'],'Partial answer')
                    self.assertFalse(future.done())
                finally:release.set()
                self.assertEqual(future.result(timeout=2).status_code,200)
            self.assertEqual(self.detail(trace_id)['trace']['status'],'completed')
        finally:release.set()

    def test_queue_link_uses_matching_boundary_and_not_unrelated_newer_trace(self):
        with tracing.request_trace(self.engine,'origin',1,'chat'):
            tracing.event('queue','Summary boundary persisted',output={'jobId':'job','requestedThroughMessageId':10})
        with tracing.request_trace(self.engine,'unrelated',1,'chat'): pass
        self.assertEqual(tracing.summary_parent(self.engine,1,'chat','job',10),'origin')
        self.assertIsNone(tracing.summary_parent(self.engine,2,'chat','job',10))

    def test_recording_failures_do_not_replay_or_block_work(self):
        with patch.object(tracing.Recorder,'_write',side_effect=lambda action:None):
            with tracing.request_trace(self.engine,'disabled',1,'chat'):
                with tracing.Span('tool','Tool',{'args':1}) as span:span.output({'ok':True})
        self.assertIsNone(self.detail('disabled'))

    def test_missing_payload_table_does_not_interrupt_or_repeat_work(self):
        AgentTracePayload.__table__.drop(self.engine)
        calls=[]
        with tracing.request_trace(self.engine,'storage-error',1,'chat'):
            with tracing.Span('tool','Synthetic mutation',{'input':1}) as span:
                calls.append('executed once')
                span.output({'ok':True})
        self.assertEqual(calls,['executed once'])
        with Session(self.engine) as session:
            self.assertEqual(session.get(AgentTrace,'storage-error').status,'completed')
