"""Private, durable agent execution records. Never queried by coach tools.

Each write has its own short transaction, so active spans are visible while a
model request is blocked. Payloads are separate and fetched only on demand.
"""
import hashlib
import json
import logging
import re
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar

from sqlmodel import Session, select
from sqlalchemy import update
from .config import settings
from .models import AgentTrace, AgentSpan, AgentTracePayload

logger = logging.getLogger(__name__)
_active = ContextVar('agent_trace', default=None)
_parent = ContextVar('agent_span', default=None)
_SECRET_KEYS = {'authorization', 'apikey', 'xapikey', 'token', 'accesstoken', 'refreshtoken',
                'password', 'secret', 'cookie', 'setcookie', 'headers'}


def ensure_trace_schema(engine):
    for model in (AgentTrace, AgentSpan, AgentTracePayload):
        model.__table__.create(engine, checkfirst=True)


def clean(value):
    try:
        return _clean(value)
    except Exception as error:
        return {'omitted':'serialization failed','errorType':type(error).__name__,'valueType':type(value).__name__}


def _clean(value):
    """Keep complete visible payloads; omit credentials and hidden reasoning."""
    if hasattr(value, 'model_dump'):
        value = value.model_dump(mode='json', exclude_none=True)
    if isinstance(value, dict):
        if value.get('type') in ('thinking', 'redacted_thinking') or value.get('thought') is True:
            return {'omitted': 'provider internal reasoning'}
        return {str(k): '[REDACTED]' if re.sub(r'[^a-z]', '', str(k).lower()) in _SECRET_KEYS
                else clean(v) for k,v in value.items() if k not in ('thinking', 'signature', 'thought_signature')}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, str):
        for secret in (settings.CLAUDE_API_KEY, settings.GEMINI_API_KEY, settings.SQL_PASSWORD):
            if secret and len(secret) >= 8:
                value = value.replace(secret, '[REDACTED]')
        value = re.sub(r'(?i)(postgres(?:ql)?(?:\+\w+)?://[^:]+:)[^@]+@', r'\1[REDACTED]@', value)
        return re.sub(r'(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED]', value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)


def fingerprint(value):
    return hashlib.sha256(json.dumps(clean(value),sort_keys=True,ensure_ascii=False).encode()).hexdigest()


class Recorder:
    def __init__(self, engine, trace_id, user_id, thread_id, *, kind='chat', name='Coach request', parent_trace_id=None):
        self.engine, self.id, self.sequence = engine, trace_id, 0
        self.user_id, self.thread_id = user_id, thread_id
        self._write(lambda s: s.add(AgentTrace(id=trace_id,user_id=user_id,thread_id=thread_id,
            kind=kind,name=name,parent_trace_id=parent_trace_id,started_at=time.time())))

    def _write(self, action):
        try:
            with Session(self.engine) as session:
                action(session)
                session.commit()
        except Exception as error:
            # No payload or provider error body is sent to ordinary logs.
            logger.warning('Trace persistence unavailable (%s)', type(error).__name__)

    def payload(self, session, data):
        safe = clean(data)
        payload_id = self.id + ':' + fingerprint(safe)
        from sqlalchemy.dialects.postgresql import insert as pg_insert
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert
        insert = sqlite_insert if session.get_bind().dialect.name == 'sqlite' else pg_insert
        session.execute(insert(AgentTracePayload).values(id=payload_id,trace_id=self.id,data=safe)
            .on_conflict_do_nothing(index_elements=['id']))
        return payload_id

    def finish(self, error=None):
        def write(session):
            session.execute(update(AgentTrace).where(AgentTrace.id == self.id).values(
                status='error' if error else 'completed', ended_at=time.time(),
                error_type=type(error).__name__ if error else None))
            session.execute(update(AgentSpan).where(AgentSpan.trace_id == self.id, AgentSpan.status == 'running')
                .values(status='interrupted',ended_at=time.time()))
        self._write(write)


class Span:
    def __init__(self, kind, name, inputs=None):
        self.recorder = _active.get()
        self.id = uuid.uuid4().hex
        self.output_data, self.error_value = None, None
        self.last_update = 0
        self.token = None
        self.closed = False
        if self.recorder:
            recorder = self.recorder
            recorder.sequence += 1
            self.row = AgentSpan(id=self.id,trace_id=recorder.id,parent_span_id=_parent.get(),
                sequence=recorder.sequence,kind=kind,name=name,started_at=time.time())
            def write(session):
                if inputs is not None:
                    self.row.input_payload_id = recorder.payload(session,inputs)
                session.add(self.row)
            recorder._write(write)

    def __enter__(self):
        self.token = _parent.set(self.id)
        return self

    def output(self, data):
        # Snapshot now: later mutations of messages/tools must not alter history.
        self.output_data = clean(data) if self.recorder else None
        return data

    def error(self, error):
        self.error_value = error

    def progress(self, data):
        if not self.recorder:
            return
        self.output(data)
        if time.monotonic() - self.last_update < 0.75:
            return
        self.last_update = time.monotonic()
        self._persist(False)

    def _persist(self, finished):
        if not self.recorder:
            return
        def write(session):
            values = dict(status=('error' if self.error_value else 'completed') if finished else 'running',
                ended_at=time.time() if finished else None,
                error_type=type(self.error_value).__name__ if self.error_value else None)
            if self.output_data is not None:
                values['output_payload_id'] = self.recorder.payload(session,self.output_data)
            session.execute(update(AgentSpan).where(AgentSpan.id == self.id).values(**values))
        self.recorder._write(write)

    def finish(self, error=None):
        if not self.closed:
            self.error_value = error or self.error_value
            if self.error_value:
                previous = self.output_data
                self.output_data = {'output':previous,'error':clean(str(self.error_value))}
            self._persist(True)
            self.closed = True

    def __exit__(self, kind, error, tb):
        self.finish(error)
        _parent.reset(self.token)


@contextmanager
def request_trace(engine, trace_id, user_id, thread_id, **kwargs):
    recorder = Recorder(engine,trace_id,user_id,thread_id,**kwargs)
    token, parent = _active.set(recorder), _parent.set(None)
    try:
        yield recorder
    except BaseException as error:
        recorder.finish(error)
        raise
    else:
        recorder.finish()
    finally:
        _active.reset(token)
        _parent.reset(parent)


@contextmanager
def parent_span(span_id):
    token = _parent.set(span_id)
    try: yield
    finally: _parent.reset(token)


def current_trace_id():
    recorder = _active.get()
    return recorder.id if recorder else None


def event(kind, name, inputs=None, output=None):
    with Span(kind,name,inputs) as span:
        span.output(output)


def _owned(session, user_id, trace_id):
    row = session.get(AgentTrace,trace_id)
    return row if row and row.user_id == user_id else None


def list_traces(session, user_id, thread_id=None):
    query = select(AgentTrace).where(AgentTrace.user_id == user_id)
    if thread_id:
        query = query.where(AgentTrace.thread_id == thread_id)
    return [r.model_dump() for r in session.exec(query.order_by(AgentTrace.started_at.desc()).limit(100)).all()]


def read_trace(session, user_id, trace_id, payloads=False):
    row = _owned(session,user_id,trace_id)
    if row is None:
        return None
    spans = session.exec(select(AgentSpan).where(AgentSpan.trace_id == trace_id).order_by(AgentSpan.sequence)).all()
    result = {'trace':row.model_dump(),'spans':[r.model_dump() for r in spans]}
    if payloads:
        result['payloads'] = {r.id:r.data for r in session.exec(select(AgentTracePayload).where(AgentTracePayload.trace_id == trace_id)).all()}
    return result


def summary_parent(engine, user_id, thread_id, job_id, through_id):
    """Use the persisted enqueue boundary, never guess from chat recency."""
    try:
        with Session(engine) as session:
            return session.exec(select(AgentTrace.id).join(AgentSpan,AgentSpan.trace_id == AgentTrace.id)
                .join(AgentTracePayload,AgentTracePayload.id == AgentSpan.output_payload_id)
                .where(AgentTrace.user_id == user_id,AgentTrace.thread_id == thread_id,AgentTrace.kind == 'chat',
                    AgentSpan.name == 'Summary boundary persisted',
                    AgentTracePayload.data['jobId'].as_string() == job_id,
                    AgentTracePayload.data['requestedThroughMessageId'].as_integer() >= through_id)
                .order_by(AgentSpan.started_at.desc()).limit(1)).first()
    except Exception:
        return None
