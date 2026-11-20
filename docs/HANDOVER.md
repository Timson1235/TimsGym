# Developer and AI handover

Last reviewed: October 28, 2026. This is a navigation guide, not a replacement
for inspecting current source and the working diff. Branches and deployed state
can differ. Start with `git status --short` and preserve existing local changes.

## Runtime and ownership map

| Concern | Source of truth |
| --- | --- |
| Frontend navigation, chat and state | `src/App.tsx` |
| HTTP client and frontend contracts | `src/lib/api.ts`, `src/types.ts` |
| Workout UI | `src/components/ActiveWorkout.tsx`, `WorkoutHistory.tsx` |
| Development process/proxy | `scripts/dev.mjs`, `vite.config.ts` |
| Production container | `Dockerfile`; FastAPI serves built `dist/` |
| API entry and routers | `backend/app/main.py`, `backend/app/routers/ai.py`, `db.py` |
| Configuration and authentication | `backend/app/config.py`, `auth.py` |
| Persistence and database models | `backend/app/crud.py`, `db.py`, `models.py` |
| Coach orchestration and Gemini loop | `backend/app/agent/coach.py` |
| Claude transport and loop | `backend/app/agent/claude_provider.py` |
| Prompt policy and context serialization | `backend/app/agent/prompts.py` |
| Tool availability and validation | `backend/app/agent/tool_registry.py` |
| Tool schemas and handlers | `backend/app/agent/tools.py` |
| Batch reads / request-local reuse | `batch_retrieval.py`, `read_cache.py` in the agent directory |
| Deterministic progression | `backend/app/agent/progression.py` |
| Conversation memory and summaries | `backend/app/memory/` |
| Private execution records | `backend/app/tracing.py`, `src/components/ExecutionTraces.tsx` |
| Synthetic evaluation runner | `backend/evals/` |

`server.ts` is the older Node implementation. The normal `npm run dev` command
launches FastAPI, not that server. Do not implement a backend feature in Node
and assume it changes the current Python runtime. Historical migration docs
and old module comments may describe earlier phases; verify against imports,
launch scripts and Dockerfile.

## Request lifecycle and invariants

1. Firebase authentication is checked server-side. The private-beta allowed UID
   and trace-admin UID are separate checks. Hiding frontend navigation is not
   authorization. Preserve both protections.
2. The coach loads an account-scoped database snapshot and conversation memory.
   General versus active-workout mode is selected from the supplied active
   state; an empty active exercise list still selects workout mode.
3. Initial context contains profile, all saved personal memories, open flags,
   selected conversation history/summary and complete active sets when present.
   Historical workout sets are retrieved through tools, not injected upfront.
   The internal database snapshot still loads history: prompt reduction does
   not imply reduced database reads.
4. General mode initially exposes `discover_tools`; active mode additionally
   exposes `log_set`, `correct_log`, `resolve_exercise`. A compact catalog lists
   other capabilities. Discovery activates native schemas for later rounds.
   Validate arguments and enforce the advertised tools before execution.
5. Direct/batch read tools share request-local cached snapshots. Equivalent
   reads can return references to earlier evidence; raw evidence stays in
   traces. Mutation attempts and provider fallback invalidate cached reads.
   There is no shared cross-user or cross-request result cache.
6. Tool results feed subsequent model rounds. Keep references resolvable if
   changing context retention. Do not remove prior results without preserving
   the evidence they contain. Full round compaction is not implemented.
7. Streaming updates the client. Actions and final state are returned through
   the existing chat contract. A workout preview is not a started or saved
   completed workout. Never replay on another provider after a mutation attempt.
8. Conversation persistence, private traces and background summary work have
   separate responsibilities. Inspect the corresponding docs before changing
   their failure handling or lifecycle.

Progression recommendations come from `suggest_weight` and the deterministic
calculator, not improvised numeric rules in the language model. Planned values
are not achieved results; missing effort remains unknown. Preserve exact set
identity, warmup/working distinctions and unfinished sets. Personal memory
writes require explicit user intent. Never infer historical set roles from load
patterns.

## Setup and service boundaries

Follow the root README for commands. Run Python commands from `backend/` so
`Settings` resolves the root `../.env` correctly. Existing local development
sometimes uses API port 8001; the launch default is 8000.

Read configuration field names in `backend/app/config.py`; `.env.example` is
not exhaustive. Required external services include Postgres with the expected
schema, Firebase token verification and a configured coaching provider. Never
print `.env`, bearer tokens, database passwords or service-account material.
Use `APP_ALLOWED_UID` and `TRACE_ADMIN_UID` deliberately; do not bypass auth to
make a manual test easier. Summary-worker settings are also in `config.py`.

Production is a built frontend served with the Python API in one container.
[Deployment](DEPLOYMENT.md) contains historical hosting instructions; inspect
Dockerfile and actual host configuration before treating them as current.
Do not assume local changes are deployed or push/merge without authorization.

## Verification and evaluation

Run the commands in README appropriate to the change. Backend tests use mocked
providers and synthetic fixtures; a green suite does not prove live provider
behavior. UI/browser test fixtures are in `tests/`; inspect their instructions
before running them. Do not assume a package test script exists.

Live evaluations are opt-in, budgeted and use synthetic accounts and SQLite.
Keep failures, original reports, limits, fixture version and code provenance.
Compare correctness together with inference time, rounds, token usage and cost.
A failed/empty response is not a performance win. Uncontrolled provider caching
and one repetition prevent causal claims about small differences. Do not read
real private conversation/trace payloads without user authorization; use the
synthetic evaluation traces for agent debugging.

Known unresolved finding at this handover: the request-read-reuse live evaluation
passed logging clarification and repeat/adapt, but the missing-effort case twice
produced reconstructed `content=[]` with `stop_reason=tool_use` before tools ran.
The cause is not established. All 149 backend tests passed at that point. These
live cases had no cache hits, so they do not establish deduplication savings.
Local ignored results are under `backend/evals/results/`; they may not exist in
a fresh clone. Resolve this finding before accepting more context compaction.

## Documentation index

- [Prompt/context and discovery architecture](COACH_PROMPTS.md)
- [Formatted prompt snapshot](CURRENT_SYSTEM_PROMPT.md) — generated review copy;
  runtime edits belong in `prompts.py` and registry/catalog source.
- [Training retrieval](TRAINING_RETRIEVAL.md)
- [Progression](PROGRESSION.md)
- [Conversation memory](MEMORY_SUBSYSTEM.md)
- [Background summaries](BACKGROUND_SUMMARIES.md)
- [Streaming](AI_STREAMING.md)
- [Traces and inspection](EXECUTION_TRACES.md)
- [Private-account access](PRIVATE_ACCESS.md)
- [Budgeted evaluations](SMALL_EVALUATIONS.md)
- [Next implementations](NEXT_IMPLEMENTATIONS.md) — planned items are not shipped.
- [Historical migration plan](FASTAPI_MIGRATION_PLAN.md)

When changing behavior, update its focused document and any prompt snapshot it
changes. Show the user clickable changed paths and relevant snippets/diffs.
Leave an explicit note about unresolved checks rather than presenting assumptions
as tested behavior. Do not add generated-by or AI co-author attribution to commits.
