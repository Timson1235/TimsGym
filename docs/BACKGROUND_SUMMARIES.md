# Durable background summaries

Chat requests no longer call the summary model. After the user/assistant messages are saved, the request persists a small queue update and returns. A worker started by FastAPI polls the database; the queue survives process restarts. There is no dependency on an in-memory task, open browser or native client.

## Stored state and consistency

`summary_jobs` has one deterministic key per account/chat. It stores the requested message boundary, completed boundary, latest rolling summary ID, status, attempts, next retry time and lease owner/expiry. New requests extend the same job rather than adding duplicates. The latest four messages are left uncompressed when enqueueing.

A worker atomically reserves a job, reads a bounded batch, releases its DB connection while generating the summary, and conditionally publishes the result. Publishing requires the same unexpired lease and previous summary ID. Summary insertion, message markers and the checkpoint update commit together. An expired worker cannot replace a later checkpoint. Clearing/deleting a chat removes its queue row first, invalidating in-flight work.

The next model request reads an immutable checkpoint and its matching pending messages. The checkpoint ID is captured with the pending rows, so a worker publishing between reads does not create a gap. The previous rolling summary is consolidated into the next one; it is not discarded after a fixed number of summary batches. Legacy chats bootstrap from the previous three summary blocks.

## Limits and failures

- Existing trigger: approximately 2,400 conversation tokens, estimated from character count.
- Batch: at most 200 messages, normally 12,000 characters. A single larger message is sent intact up to 60,000 characters. Larger messages leave the job retryable/failed rather than being silently archived after truncation.
- Generated memory: validated JSON containing a label (1–120 characters) and summary (1–6,000 characters). Malformed output leaves original messages active.
- Context tail: up to 200 pending messages and approximately 16,000 characters. If the worker falls behind, the prompt states that some pending detail is omitted. Full original messages remain stored; the visible history endpoint still returns its latest 200 messages independently of compaction.
- Worker checks every five seconds when idle. Failed generation retries after increasing delays, up to five attempts. Expired leases recover interrupted work, also with a bounded attempt count.
- A terminal failure does not block chat. Newer pending work can reopen the job. Operators can inspect `summary_jobs.status`, `attempts` and sanitized `last_error_type`; a manual retry can set that row's status to `pending`, attempts to zero and available_at to zero.
- Successfully published background usage is recorded separately in existing account metrics. It is not added to the latency or usage of the foreground reply. Unpublished/failed provider calls are not fully reflected in these estimates.

Summaries are lossy model-generated memory, not a replacement for structured workout records or original messages. They preserve user-stated constraints, preferences, corrections and open questions; numerical training progression still uses database tools.

## Deployment

On API startup, `ensure_summary_schema(engine)` creates the new `summary_jobs` table if missing and ensures the existing `summaries` table exists. Existing tables/data/embedding columns are not altered. The database role needs permission to create the missing table/indexes. The backend's SQLModel models own this table, as with existing Python memory tables.

Default settings:

```dotenv
SUMMARY_WORKER_ENABLED=true
SUMMARY_TIMEOUT_SECONDS=45
MEM_SUMMARY=true
```

Each API process may start a worker; database claims coordinate them. `SUMMARY_WORKER_ENABLED=false` leaves queue persistence enabled but stops processing in that process. `MEM_SUMMARY=false` stops automatic queueing/processing. This does not add an agent tool.

The startup/queue checks log failures without making queue persistence mandatory for chat. Integration tests use a temporary SQLite database and mocked providers; they do not call paid providers or change the configured Postgres database.

## Changed files and key code

- [models.py](/Users/tim/Work/TimsGym/backend/app/models.py): `SummaryJob` stores `requested_through_id`, `completed_through_id`, `summary_id`, `lease_token` and retry state. `ConversationSummary` maps the existing table without depending on pgvector.
- [summary_jobs.py](/Users/tim/Work/TimsGym/backend/app/memory/summary_jobs.py): durable upsert, atomic claims, bounded batches, retry handling, fenced publication, background accounting and the worker loop.

```python
fenced = session.execute(update(SummaryJob).where(
    SummaryJob.id == claim.id,
    SummaryJob.lease_token == claim.token,
    SummaryJob.status == 'running',
    SummaryJob.lease_until > time.time(),
    SummaryJob.summary_id == claim.previous_id,
).values(last_error_type=None))
```

- [summary.py](/Users/tim/Work/TimsGym/backend/app/memory/summary.py): `generate_summary()` validates provider output; `read_coach_context()` captures a consistent checkpoint/tail. No raw-transcript fallback gets archived after invalid JSON.
- [coach.py](/Users/tim/Work/TimsGym/backend/app/agent/coach.py): replace both synchronous summary calls with context retrieval and post-persistence queueing.

```python
history, summary_ctx = summ.read_coach_context(session, user.id, thread_id)
# ... generate and persist the regular reply ...
summary_queued = _try_enqueue_summary(session, user.id, thread_id)
```

- [conversational.py](/Users/tim/Work/TimsGym/backend/app/memory/conversational.py): visible history no longer filters `summary_id`; clear/delete invalidates the queue before removing messages.
- [main.py](/Users/tim/Work/TimsGym/backend/app/main.py): schema setup and worker start/stop during API lifecycle.
- [config.py](/Users/tim/Work/TimsGym/backend/app/config.py): worker and provider timeout settings.
- [flags.py](/Users/tim/Work/TimsGym/backend/app/memory/flags.py): updated description of background summarization.
- [test_summary_jobs.py](/Users/tim/Work/TimsGym/backend/tests/test_summary_jobs.py): persistence, coalescing, restart recovery, stale workers, bounded retries, in-flight chat deletion, account isolation, complete batches, context races, usage accounting and real worker/streaming integration with a blocked fake provider.
- [test_summary_resilience.py](/Users/tim/Work/TimsGym/backend/tests/test_summary_resilience.py): failed queue persistence and invalid summary output retain chat/originals.
- [test_chat_sessions.py](/Users/tim/Work/TimsGym/backend/tests/test_chat_sessions.py): summarized messages stay visible, while agent active-message retrieval remains separate.
- [test_coach_tools.py](/Users/tim/Work/TimsGym/backend/tests/test_coach_tools.py): existing agent tests mock checkpoint retrieval/queueing instead of synchronous summarization.
- [test_summary.py](/Users/tim/Work/TimsGym/backend/scripts/test_summary.py): scratch-thread manual test uses the durable worker path; it calls the configured model, so run it only against an intended test database.

## Verification

```sh
cd backend
.venv/bin/python -m unittest discover -s tests
```

The streaming integration test starts the actual API worker with a deliberately blocked fake summary provider. The chat still returns its final SSE event before the provider is released, then the summary commits afterward. Restart tests reopen the queue database with a new engine; lease tests replace an expired worker and reject the old result.
