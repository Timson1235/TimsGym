"""Durable summary queue: coalescing, expiring leases, retries and fenced publishing.

Every API process may run a worker. Atomic DB claims serialize a chat across
processes; no request session or in-memory task is needed to recover work.
"""
import hashlib
import logging
import threading
import time
import uuid
from dataclasses import dataclass

from sqlalchemy import and_, case, or_, update
from sqlmodel import Session, select

from ..config import settings
from .. import tracing
from ..models import ConversationSummary, Message, SummaryJob
from . import context, summary
from .flags import flags

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 5
KEEP_RECENT = 4
BATCH_CHARS = 12000
MAX_SINGLE_MESSAGE_CHARS = 60000


def ensure_summary_schema(engine):
    # Existing summaries may also contain a nullable pgvector embedding column.
    ConversationSummary.__table__.create(engine, checkfirst=True)
    SummaryJob.__table__.create(engine, checkfirst=True)
    tracing.ensure_trace_schema(engine)


def _job_id(user_id, thread_id):
    return hashlib.sha256(f'{user_id}:{thread_id}'.encode()).hexdigest()


def enqueue_if_needed(session: Session, user_id: int, thread_id: str) -> bool:
    if not flags.summary or not flags.conversational or not (settings.CLAUDE_API_KEY or settings.GEMINI_API_KEY):
        return False
    messages = session.exec(select(Message).where(Message.user_id == user_id, Message.thread_id == thread_id,
        Message.summary_id == None).order_by(Message.id.desc()).limit(200)).all()
    if len(messages) <= KEEP_RECENT or not context.should_summarize('\n'.join(m.content for m in messages)):
        return False
    # Keep the latest two exchanges out of this job, including across retries.
    through_id = messages[KEEP_RECENT].id
    enqueue_through(session, user_id, thread_id, through_id)
    return True


def enqueue_through(session: Session, user_id: int, thread_id: str, through_id: int):
    """Atomic upsert. A newer request extends pending work without stealing a lease."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert
    insert = sqlite_insert if session.get_bind().dialect.name == 'sqlite' else pg_insert
    statement = insert(SummaryJob).values(id=_job_id(user_id, thread_id), user_id=user_id,
        thread_id=thread_id, requested_through_id=through_id, completed_through_id=0,
        status='pending', attempts=0, available_at=0, lease_until=0)
    # A stale enqueue cannot reopen already completed work or reset a retry loop.
    terminal = SummaryJob.status.in_(['completed', 'failed'])
    statement = statement.on_conflict_do_update(index_elements=['id'],
        set_={'requested_through_id': through_id,
              'status': case((terminal, 'pending'), else_=SummaryJob.status),
              'attempts': case((terminal, 0), else_=SummaryJob.attempts),
              'available_at': case((terminal, 0), else_=SummaryJob.available_at)},
        where=SummaryJob.requested_through_id < through_id)
    session.execute(statement)
    session.commit()
    tracing.event('queue', 'Summary boundary persisted', output={'jobId':_job_id(user_id,thread_id),
        'requestedThroughMessageId':through_id, 'keepRecent':KEEP_RECENT})


@dataclass(frozen=True)
class Claim:
    id: str
    user_id: int
    thread_id: str
    token: str
    through_id: int
    previous_id: str | None


def claim_next(session: Session, now=None, job_id=None) -> Claim | None:
    now = time.time() if now is None else now
    session.execute(update(SummaryJob).where(SummaryJob.status == 'running', SummaryJob.lease_until <= now,
        SummaryJob.attempts >= MAX_ATTEMPTS).values(status='failed', lease_token=None, last_error_type='WorkerInterrupted'))
    session.commit()
    eligible = and_(SummaryJob.requested_through_id > SummaryJob.completed_through_id,
        or_(and_(SummaryJob.status == 'pending', SummaryJob.available_at <= now),
            and_(SummaryJob.status == 'running', SummaryJob.lease_until <= now)))
    if job_id is not None:
        eligible = and_(eligible, SummaryJob.id == job_id)
    candidates = session.exec(select(SummaryJob.id).where(eligible).order_by(SummaryJob.available_at, SummaryJob.id).limit(10)).all()
    for job_id in candidates:
        token = uuid.uuid4().hex
        changed = session.execute(update(SummaryJob).where(SummaryJob.id == job_id, eligible).values(
            status='running', lease_token=token, lease_until=now + max(120, settings.SUMMARY_TIMEOUT_SECONDS * 3),
            attempts=SummaryJob.attempts + 1))
        session.commit()
        if changed.rowcount:
            job = session.get(SummaryJob, job_id, populate_existing=True)
            return Claim(job.id, job.user_id, job.thread_id, token, job.requested_through_id, job.summary_id)
    return None


def _batch(session, claim):
    rows = session.exec(select(Message).where(Message.user_id == claim.user_id, Message.thread_id == claim.thread_id,
        Message.summary_id == None, Message.id <= claim.through_id).order_by(Message.id).limit(200)).all()
    selected, size = [], 0
    for row in rows:
        line_size = len(row.content) + len(row.role) + 4
        if selected and size + line_size > BATCH_CHARS:
            break
        if line_size > MAX_SINGLE_MESSAGE_CHARS:
            raise ValueError('Message exceeds summary batch limit')
        selected.append((row.id, row.role, row.content))
        size += line_size
    return selected


def process_claim(engine, claim: Claim) -> bool:
    parent_id = tracing.summary_parent(engine, claim.user_id, claim.thread_id, claim.id, claim.through_id)
    with tracing.request_trace(engine, uuid.uuid4().hex, claim.user_id, claim.thread_id,
            kind='summary', name='Background summary', parent_trace_id=parent_id):
        with tracing.Span('summary', 'Compact conversation', {'jobId':claim.id,
                'throughMessageId':claim.through_id,'previousSummaryId':claim.previous_id}) as span:
            result = _process_claim(engine,claim)
            span.output({'published':result})
            return result


def _process_claim(engine, claim: Claim) -> bool:
    """Release DB connections during the provider call; publish in one transaction."""
    with Session(engine) as session:
        batch = _batch(session, claim)
        previous = summary.read_summary_context(session, claim.user_id, claim.thread_id)
    if not batch:
        _finish_empty(engine, claim)
        return False
    tracing.event('context_selection','Summary source messages', output={'messageIds':[row[0] for row in batch], 'previousSummaryId':claim.previous_id, 'maxBatchCharacters':BATCH_CHARS})
    transcript = '\n'.join(f'[{role.upper()}] {content}' for _, role, content in batch)
    started = time.perf_counter()
    generated = summary.generate_summary(transcript, previous)
    duration_ms = round((time.perf_counter() - started) * 1000)
    with Session(engine) as session:
        # This conditional write locks the job row until summary+markers commit.
        # Expired workers, chat deletion and newer lease owners cannot publish.
        fenced = session.execute(update(SummaryJob).where(SummaryJob.id == claim.id,
            SummaryJob.lease_token == claim.token, SummaryJob.status == 'running',
            SummaryJob.lease_until > time.time(), SummaryJob.summary_id == claim.previous_id).values(last_error_type=None))
        if not fenced.rowcount:
            session.rollback()
            return False
        ids = [row[0] for row in batch]
        current = session.exec(select(Message.id).where(Message.id.in_(ids), Message.user_id == claim.user_id,
            Message.thread_id == claim.thread_id, Message.summary_id == None).order_by(Message.id)).all()
        if current != ids:
            session.rollback()
            return False
        summary_id = uuid.uuid4().hex
        session.add(ConversationSummary(id=summary_id, user_id=claim.user_id, thread_id=claim.thread_id,
            description=generated['description'], summary_text=generated['summary'], full_content=transcript))
        session.execute(update(Message).where(Message.id.in_(ids), Message.user_id == claim.user_id,
            Message.thread_id == claim.thread_id).values(summary_id=summary_id))
        job = session.get(SummaryJob, claim.id, populate_existing=True)
        job.summary_id = summary_id
        job.completed_through_id = ids[-1]
        job.status = 'pending' if job.requested_through_id > ids[-1] else 'completed'
        job.lease_token, job.lease_until = None, 0
        job.attempts, job.available_at = 0, 0
        job.completed_at = time.time()
        job.last_usage = generated.get('usage')
        session.add(job)
        session.commit()
        if generated.get('usage'):
            # Account totals include background usage, separately from chat latency.
            from ..observability import write_ai_request_metric
            write_ai_request_metric(session, user_id=claim.user_id, thread_id=claim.thread_id,
                usage=generated['usage'], trace=dict(requestId=f'summary:{summary_id}', totalMs=duration_ms,
                    agentSteps=1, modelMs=duration_ms, steps=[dict(kind='llm', name='Background conversation summary',
                        durationMs=duration_ms)]))
    logger.info('Summary job completed job=%s through=%s', claim.id, ids[-1])
    return True


def _finish_empty(engine, claim):
    with Session(engine) as session:
        session.execute(update(SummaryJob).where(SummaryJob.id == claim.id, SummaryJob.lease_token == claim.token,
            SummaryJob.lease_until > time.time()).values(status='completed', lease_token=None, lease_until=0,
                completed_through_id=claim.through_id, attempts=0))
        session.commit()


def fail_claim(engine, claim, error):
    with Session(engine) as session:
        job = session.get(SummaryJob, claim.id)
        if not job or job.lease_token != claim.token:
            return
        terminal = job.attempts >= MAX_ATTEMPTS
        session.execute(update(SummaryJob).where(SummaryJob.id == claim.id, SummaryJob.lease_token == claim.token).values(
            status='failed' if terminal else 'pending', lease_token=None, lease_until=0,
            available_at=time.time() + min(300, 5 * 2 ** min(job.attempts, 6)), last_error_type=type(error).__name__))
        session.commit()
    logger.warning('Summary job failed job=%s error=%s terminal=%s', claim.id, type(error).__name__, terminal)


def run_once(engine) -> bool:
    if not flags.summary or not (settings.CLAUDE_API_KEY or settings.GEMINI_API_KEY):
        return False
    with Session(engine) as session:
        claim = claim_next(session)
    if claim is None:
        return False
    try:
        process_claim(engine, claim)
    except Exception as error:
        fail_claim(engine, claim, error)
    return True


class SummaryWorker:
    def __init__(self, engine):
        self.engine = engine
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name='summary-worker', daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        # Provider calls have their own timeout. Leases recover interrupted work.
        self.thread.join(timeout=2)

    def _run(self):
        while not self.stop_event.is_set():
            try:
                worked = run_once(self.engine)
            except Exception as error:
                logger.warning('Summary worker unavailable (%s)', type(error).__name__)
                worked = False
            self.stop_event.wait(0.2 if worked else 5)
