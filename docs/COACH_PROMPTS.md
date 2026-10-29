# Coaching prompts and native tool discovery

The coach now selects a general-coaching or active-workout instruction block,
sharing grounding, progression, personal memory and safety rules. An active
workout is present when the request's `activeWorkoutState` is not null; an empty
exercise list still selects workout mode. This remains client-supplied state,
not a new server-side session lifecycle.

## Request context

`backend/app/agent/prompts.py` builds a stable system prefix followed by
`=== USER DATA ===` and compact JSON. Every request includes profile fields,
all saved personal memories, open flags and the existing conversation summary.
Recent messages remain native provider messages under the existing memory
selection policy; they are not duplicated into the JSON. Current local time is
appended after the dynamic data.

Active workouts include the complete exercise list, prescription fields,
progression settings, notes and every set. Each set has distinct `planned` and
`actual` objects. Pending sets have null actuals; completed legacy sets without
original prescriptions have null plans. Unknown reported effort stays null.

Historical workouts and the old keyword-selected main-lift dump are not sent
upfront. They remain accessible through account-scoped tools. Internally the
existing database snapshot and API response contract are unchanged.

## Native tool discovery

`backend/app/agent/tool_registry.py` combines each declaration and handler with
its concise catalog purpose and read-only classification. Existing tool schema
and handler exports remain compatible; the registry is the execution and
availability authority used by the coach. `jsonschema` validates arguments
against recursively normalized schemas before handlers run, including unknown
properties and nested fields. Non-finite numeric arguments are rejected.

- General mode initially offers `discover_tools` only.
- Active mode also offers `log_set`, `correct_log` and `resolve_exercise`.
- Both modes see short catalog descriptions, not all parameter schemas.
- `discover_tools({"names":["get_session_summary","get_exercise_history"]})`
  activates native schemas for the next model round. Discover independent tools
  together. Discovery itself executes no workout action.
- Availability is frozen for a whole response's tool-call batch. Discovery does
  not authorize sibling calls in that same batch.
- Activated tools persist only within this request. Both providers refresh their
  declarations before each round; a fresh user message starts with the core.
- Discovery never disables provider fallback. A mutation attempt still blocks
  fallback to avoid replaying changes.

### Read-only batch retrieval

Discover `batch_retrieve` alongside `start_workout_session` for repeat/adapt
requests. One call can contain up to 16 independent session-summary, exercise-
history, exact-workout, identity-resolution and progression requests:

```json
{
  "requests": [
    {"key":"reference","tool":"get_session_summary","arguments":{"search_title_or_date":"full body","limit":1,"include_details":true}},
    {"key":"press_last","tool":"get_exercise_history","arguments":{"exercise_name":"Barbell Overhead Press","limit":1}}
  ]
}
```

Results are keyed and retain each original tool's structured statuses, canonical
identities, effort and evidence. Once the reference reveals exercise identities,
request all needed `suggest_weight` results in the next batch. Direct tools and
multiple native calls per round remain available; batching is a model choice.
Only the five named read-only handlers are allowed inside a batch, without
requiring separate discovery of each one. Mutations, recursive batches and tool
discovery cannot execute through it.

The batch reuses original declarations for parameter hints and validates each
child against its original schema. Malformed outer schemas fail before execution;
child-specific argument/handler failures return errors alongside the other
results. Keys must be unique. Exact duplicate requests execute once and return a
`duplicateOf` reference; no identical result is repeated. With full session
information, the redundant exercise/set summary projection is omitted while the
complete recorded workout remains intact.

Children execute sequentially against the same account snapshot/session; this is
batching across the model boundary, not concurrent use of a SQLAlchemy session.
Every child has a nested `retrieval` trace span with its arguments and result.
The batch itself remains read-only for fallback handling.

Conversation summaries and saved personal memory still use the existing initial
context policy; this adds workout-summary retrieval, not a conversation-archive
search tool. The full readable workout proposal remains in chat, with the same
start button. No detailed preview card or evaluation runner is added here.

A synthetic integration test covers discovery → mixed history batch → progression
batch → preview → final answer in five model rounds for both providers (streaming
Claude included). This validates capability, not guaranteed live latency/cost or
a promise that the model always chooses the shortest path.

Each provider run permits six work rounds plus up to two discovery-only rounds,
followed by a reserved answer-only round (at most nine requests). Simple requests
still finish as soon as they have an answer. Tool calls are disabled for the final
round, and the server rejects any calls a provider nevertheless returns there.
A third discovery-only response is rejected and triggers finalization. A response
containing both discovery and other calls counts as a work round. Finalization
summarizes confirmed results and outstanding work without claiming an uncreated
preview exists. Trace metadata distinguishes `completed`, `round_limit` and
`empty_response`; an empty response is not automatically called a budget failure.

The previous four-work-round limit stopped legitimate dependent retrieval and
progression sequences before preview creation. Regression tests now cover
resolution → history → progression → additional history → remaining progression
→ preview → answer on both providers.

## Inspecting execution

The existing private trace viewer records prompt mode/version, structured
context, initial and activated tools, discovery calls/results, and each model
round's actual schemas. Initial context token estimates include tool schemas.
Provider-reported input/cache usage remains authoritative; changing toolsets
can reduce cache reuse even while the first request becomes smaller. No new
trace permissions or agent-accessible tracing tools were added.

## Measured initial payload sizes

Initial v2 measurements, before the subsequent batching-guidance update,
against the working-tree implementation immediately before this
refactor, using synthetic data: six library exercises, three completed workouts,
four sets per exercise, two saved memories, and one short current message.
The active fixture has six exercises with two completed and two pending sets
each. Compact serialized Claude payloads include native schemas, system blocks,
cache markers and the message; the model name is a synthetic constant. Both
versions omit a conversation tail/summary and the shared clock suffix for this
comparison. The new version includes full active set state; the old version
included only a brief active-workout summary.

| Mode | Before | After | Byte reduction | Estimated tokens before → after |
| --- | ---: | ---: | ---: | ---: |
| General | 25,505 bytes | 5,237 bytes | 79.5% | 6,319 → 1,309 |
| Active workout | 25,614 bytes | 13,340 bytes | 47.9% | 6,346 → 3,334 |

Token estimates use the app's character-based estimator, not a provider
tokenizer. These numbers describe this fixture, not guaranteed latency,
per-request billing or total tool-loop savings: discovery adds a model round,
and actual session/memory lengths vary.

## Review decisions and deferred work

This implements the mode split, duplicate-rule consolidation, tool-description
ownership, neutral goals/language, explicit cold start and structured context
from the October 23 prompt review. Existing profile unit preferences are exposed,
but tools retain existing storage-unit semantics; no stored values are silently
relabelled or converted.

The review's specific top-set increment diagnosis was not established in the
current progression code: mixed planned working weights already return
`needs_review`. No historical set roles are inferred. Equipment preferences,
end-to-end unit conversion, explicit top/back-off sets and narrower database
queries remain separate follow-ups. Current private access remains unchanged.

## Verification

Run `cd backend && .venv/bin/python -m unittest discover -s tests -q`.
The synthetic discovery tests exercise both providers, parallel history lookup,
preview creation, direct logging, schema validation, same-batch rejection,
streamed discovery, fallback and loop exhaustion. Existing streaming,
progression, memory, access-control and trace tests remain in the suite.

## Step 1: session projections and pagination

`get_session_summary` defaults to IDs, dates, titles, duration, exercise IDs/names
and at most 300 characters of session notes (`notesTruncated` marks a cut). No
sets, achieved weights/reps, effort, plans or total-volume calculation are sent
in summary mode. `include_details=true` instead returns each original full record
in `workout`, without a duplicate exercise/set projection.

Pages expose `returned`, `effectiveLimit`, `hasMore`, `nextCursor`, the projection
and title/date coverage. Follow the opaque cursor with the same filter to browse
beyond ten workouts. It anchors to an existing ID/date in the authenticated
account's filtered snapshot, preserving existing same-day DB ordering. Newer
insertions do not shift the anchor; deletion/date changes invalidate it and require
a restart. This is not snapshot isolation across requests or semantic search.

The batch tool inherits the cursor parameter and schema from the original tool.
No embeddings, persisted workout summaries, read caching, between-round
compaction or progression/grading changes are included in this step.

## Request-wide read reuse (October 28)

`read_cache.py` is created inside each `run_chat` call and shared by direct reads
and `batch_retrieve`. Exact normalized reads reuse snapshots: unambiguous exercise
aliases/IDs and equivalent defaults share keys; limits, detail mode, filters and
cursors remain distinct. Failed reads are not cached. Writes are never cached.
Every mutation attempt invalidates all read state before execution, including
failed attempts. Provider fallback clears references because its conversation
starts fresh. Nothing is shared between requests or accounts.

Full raw evidence remains in tool traces. Model feedback adds a `resultRef`;
repeated reads return a short `reused` reference. Full workouts already sent in
detailed sessions can satisfy later detail requests. Identical full workouts use
`dataRef` paths, and exercise-history sets can reference a previously sent full
workout only when their completed-set projection matches exactly. Planned and
incomplete sets never become recorded outcomes through this projection. References
are only applied when shorter than the inline set data. This is
conservative overlap removal, not general extraction or between-round compaction:
history-first/full-workout-later overlaps are still sent in full, as are summaries
whose pages overlap. Earlier provider messages remain available for references.

Traces include cache hit/miss events and invalidations; returned request metrics
and evaluation records include `readCache` counters. A hit avoids a handler read;
it does not remove a model round or guarantee lower latency/cost. Current handlers
still use the existing database snapshot.
