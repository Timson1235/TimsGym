# Stored execution traces and live inspection

Open **Execution traces** using the activity/pulse icon beside Settings while signed in. It opens `/?view=traces` in a separate tab. Leave the coach open in the original tab, send a message, and watch the trace appear. The viewer follows the newest trace by default; selecting a trace disables following so you can inspect it without being switched away.

The list refreshes every two seconds; selected span metadata refreshes every second. Expand Input/Output to load the payload. Model streams persist partial visible output at most once every 750 ms and save the complete final output on completion or error. Pause live updates with the checkbox. Export JSON downloads the trace, spans and payload records, including saved progress snapshots.

## Storage

- `agent_traces`: one record per foreground chat request, using the existing request ID; separate linked records for background summary attempts. Includes account/chat ownership, kind, timestamps and status.
- `agent_spans`: sequence, parent span, phase name, timestamps, running/completed/error/interrupted status, error type and input/output payload references.
- `agent_trace_payloads`: complete sanitized JSON snapshots. Identical payloads deduplicate within a trace using a content hash. These are separate from lightweight list/span metadata. There is no 8,000-character tool-result truncation in this store.

The additive tables are created on API startup. Existing tables are not changed. Records remain stored until explicitly removed through database maintenance; chat-history compaction/deletion does not delete this separate debugging dataset. The viewer lists the most recent 100 traces, while older stored records remain queryable/exportable by ID or directly through the database.

New records are always enabled. A failed telemetry write does not retry a model request or tool mutation. Such failures produce a sanitized diagnostic, so storage availability still determines whether all spans can be recorded. Small synchronous transactions make newly started spans visible while a provider call is in flight; they add database overhead. Streaming progress writes are throttled, and the visible text chunk is emitted before its progress record is persisted.

## Captured phases and payloads

- Request input and final reply/actions/usage; the full refreshed database is excluded from the response payload.
- Context assembly: system prompt, pending messages, summary block, offered tools, estimated text tokens and static prompt fingerprint.
- Context selection: selected message IDs, compressed message boundary, summary IDs, shortened/omitted pending messages, query/budget limits, profile fields, personal-memory indexes, flags and active-workout ID.
- Claude rounds: actual Messages request body, assembled response, usage/cache tokens, tool calls and stop reason. Tool spans attach to the model round that requested them.
- Gemini rounds and each individual model retry: logical SDK input (`model`, `contents`, `config`), assembled response and usage. This is the SDK input representation rather than the SDK's private HTTP wire encoding.
- Tool execution: provider call ID, arguments, complete handler result, exact feedback passed back to the model, duration and errors.
- Explicit Claude→Gemini fallback event; Gemini model fallback attempts have individual spans.
- Conversation persistence and summary queueing.
- Background summary attempts: source message IDs, previous summary ID, requested boundary, provider prompt, returned JSON/usage and publication result. Parent links come from a matching persisted enqueue event, not a guess based on the latest chat. Jobs created outside a traced request can have no parent.

Estimated context tokens use the app's character heuristic and are labeled as estimates. Provider usage in model outputs is authoritative when returned. Tool schemas/configuration are present in model request payloads; the context estimate itself counts prompt/history text rather than exact provider tokenization of the full request.

## Access and exclusions

All read endpoints require Firebase authentication plus the configured trace administrator UID. The app itself is currently restricted to its owner UID. Trace queries remain scoped to that owner account; administrator status does not expose other accounts’ records. Payload lookup additionally verifies that the payload belongs to the requested owned trace. Responses use `Cache-Control: no-store`. The coach has no trace-reading tool; tracing adds no agent tool. No tracing data is injected into prompts or summary memory.

Capture excludes HTTP headers, API-key/token/password fields, configured provider secrets, bearer tokens, database URL passwords and provider internal reasoning/signatures. Redacted/omitted fields are marked; payloads are therefore sanitized visible execution records, not unmodified wire dumps. Other user conversation and fitness information is intentionally retained in these private records. The coding assistant's tests use synthetic data and do not inspect stored user traces.

The old console payload printing and stdout timing dump have been removed from the coach path. Normal sanitized operational diagnostics may still be emitted. Existing aggregate metrics and legacy tool audit tables remain for compatibility.

A process killed abruptly can leave a trace marked running; the viewer shows persisted state and elapsed time and does not infer that a request finished without a completion record. The summary job's own lease/retry recovery remains separate from trace status.

## Read/export API

```text
GET /api/ai/traces[?threadId=...]
GET /api/ai/traces/{trace_id}
GET /api/ai/traces/{trace_id}/payload/{payload_id}
GET /api/ai/traces/{trace_id}?payloads=true
```

All require the same signed-in account authorization as the chat API. These endpoints are read-only and are not agent tools.

## Files changed and key code

- [models.py](/Users/tim/Work/TimsGym/backend/app/models.py): `AgentTrace`, `AgentSpan`, `AgentTracePayload` store metadata and JSON separately.
- [tracing.py](/Users/tim/Work/TimsGym/backend/app/tracing.py): independent DB writes, immutable sanitized snapshots, nested spans, progress updates, deduplication, ownership checks and summary-parent lookup.

```python
with tracing.Span('tool', name, {'callId': call_id, 'arguments': args}) as span:
    feedback = _execute_tool(name, args, call_id)
    span.output({'result': span.output_data, 'feedbackToModel': feedback})
```

- [routers/ai.py](/Users/tim/Work/TimsGym/backend/app/routers/ai.py): wrap authenticated execution in `request_trace(...)`; add account-scoped read/export endpoints.
- [coach.py](/Users/tim/Work/TimsGym/backend/app/agent/coach.py): context/tool/persistence/queue spans, Gemini rounds/retries/fallbacks, source-selection events and prompt fingerprint.
- [claude_provider.py](/Users/tim/Work/TimsGym/backend/app/agent/claude_provider.py): persist each exact request body and visible response; partial output; associate tools with their requesting round; remove payload console printing.
- [memory/summary.py](/Users/tim/Work/TimsGym/backend/app/memory/summary.py): record memory-selection decisions and summary model input/output.
- [memory/summary_jobs.py](/Users/tim/Work/TimsGym/backend/app/memory/summary_jobs.py): queue boundary events and linked background execution traces.
- [main.py](/Users/tim/Work/TimsGym/backend/app/main.py): ensure additive trace schema at startup.
- [config.py](/Users/tim/Work/TimsGym/backend/app/config.py): document the old prompt-console flag as legacy compatibility.
- [ExecutionTraces.tsx](/Users/tim/Work/TimsGym/src/components/ExecutionTraces.tsx): live metadata polling, lazy payload expansion, follow/pause/filter controls and JSON export.

```tsx
const result = await load(`/${encodeURIComponent(selected)}`);
setDetail(result);
// Poll again after one second when live updates are enabled.
```

- [api.ts](/Users/tim/Work/TimsGym/src/lib/api.ts): authenticated `fetchExecutionTrace()` with browser caching disabled.
- [Navbar.tsx](/Users/tim/Work/TimsGym/src/components/Navbar.tsx): signed-in activity icon opens `/?view=traces` in another tab.
- [App.tsx](/Users/tim/Work/TimsGym/src/App.tsx): authenticated standalone viewer, keyed to the current account.
- [test_execution_traces.py](/Users/tim/Work/TimsGym/backend/tests/test_execution_traces.py): immutable/full payloads, redaction, tool/round linkage, actual feedback, per-attempt retries, account isolation, export and live reads during a blocked fake model call.
- [executionTraces.browser.tsx](/Users/tim/Work/TimsGym/tests/executionTraces.browser.tsx) and [HTML fixture](/Users/tim/Work/TimsGym/tests/executionTraces.browser.html): synthetic running→completed UI fixture without real account/provider/database access.

## Verification

Backend tests use temporary SQLite databases and mocked model providers. The live integration test blocks a synthetic model call, reads its running span/partial output through the authenticated API before releasing the call, and then verifies completion. The provider-loop test verifies that round 1's input remains unchanged and round 2 receives the exact recorded tool feedback.

The browser fixture tests span expansion and live transition to new tool/model spans. Tests do not read production traces or call paid model providers. The three new tables were also verified to exist in the configured Postgres database using schema inspection only; no stored trace rows were read. Functional behavior with real provider calls is not verified by these isolated tests.
