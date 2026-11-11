# Streaming coach responses and provider caching

## Request path

The main coach sends `POST /api/ai/chat` with `stream: true`. The existing JSON response remains available to older clients that omit this flag.

Authentication and chat ownership are checked before streaming starts. A worker runs the existing synchronous agent loop with its own SQLModel session. A queue transfers events to a FastAPI `StreamingResponse` (SSE), with heartbeat comments during quiet periods. Proxy buffering is disabled through response headers where supported.

Events:

- `ready`: accepted client request identifier; enables the interrupt control.
- `status`: user-facing progress (loading context, checking history, executing tools, saving).
- `delta`: incremental assistant text; private model thinking and partial tool arguments are never forwarded.
- `reset`: clear the current draft when a new agent round or fallback begins.
- `final`: the authoritative existing response object, including reply, actions, workout state, usage and trace.
- `error`: terminal failure. The client does not automatically retry because tools may already have changed data.

The browser decodes chunked UTF-8 and SSE frames, renders draft text separately from persisted messages, then replaces it with the confirmed final message. Incomplete streamed drafts are not written into the chat cache.

Claude tool arguments are reassembled and parsed only after complete content blocks. Truncated/interrupted rounds do not execute their tools. A provider failure after an attempted mutation does not replay the request through Gemini. Gemini streaming similarly assembles complete response parts before the agent executes tools.

Empty/whitespace-only Claude responses and `stop_reason=tool_use` responses without
tool blocks are provider failures, not successful completions. Both JSON and SSE
paths record an error. Before any mutation attempt, the existing configured
Gemini fallback may recover; after a mutation attempt, no replay occurs and the
user is told to check the saved state. There is no automatic same-provider retry.

## Interrupt and retry

The chat composer replaces Send with an accessible square Interrupt button while
a turn is running. Once the server sends `ready`, the button calls authenticated
`POST /api/ai/chat/{clientRequestId}/interrupt`. It keeps reading the original
stream rather than aborting the connection and losing the final workout state.
The UI displays a stopping state until the server confirms the outcome.

`chat_control.py` holds account/thread-scoped cooperative stop events. The coach
checks before provider work, on provider stream events, and before every tool.
Interruption bypasses provider fallback and is persisted as an interrupted turn.
An in-flight HTTP read/tool can finish before stopping; there is no hard kill,
rollback or guaranteed immediate provider-billing cancellation. Completed
actions and the resulting active workout/database are returned in the final
response. A second streaming request for the same account/thread receives 409
until the original worker finishes, even if its client disconnected.

This registry matches the current single-process Uvicorn Docker entry point.
Multiple workers or replicas require a shared control store (and shared
in-flight exclusion); do not scale out this in-memory registry unchanged.

Final responses include `status` and `retrySafe`. Failed/interrupted turns show
Try again. A confirmed no-mutation outcome can be retried directly; mutation
attempts and unknown transport outcomes require explicit review confirmation.
Retries are new requests using the current workout state, never automatic
replays. Local failure controls survive history refresh until a newer server
answer supersedes them; historical server messages without local retry metadata
are not classified by guessing from their prose.

The Active Workout tab separately uses a single-open exercise accordion. Its
headers show completed/total sets; collapsing hides editors without changing
workout values. The first unfinished exercise opens initially, and adding an
exercise opens it. This does not change workout previews inside chat.

If a client disconnects, the worker finishes the existing request/persistence but stops buffering events. This is an in-process worker, not a durable background-job service; server termination can still interrupt it. There is no automatic reconnect/replay.

## Prompt caching

The coaching prompt starts with stable general rules, followed by a `=== USER DATA ===` boundary and changing account/session context, time and conversation summaries. User names no longer appear in the static opening sentence.

Claude places explicit `cache_control: {"type":"ephemeral"}` breakpoints on the stable system block and final tool definition. This uses the default five-minute TTL and the provider's eligibility thresholds. No changing user data is marked with a cache breakpoint. Set `CLAUDE_PROMPT_CACHING=false` to disable these breakpoints.

Gemini uses its default implicit caching on supported models. Stable prompt ordering improves eligibility; no paid explicit cache objects are created. Hits are not guaranteed.

Usage retains cache creation/read token counts. The response trace also includes `firstTextMs`, visible in expanded trace details. This measures first emitted text, which may be a preliminary tool-round message, rather than time to completed answer. Streaming improves time to visible output, not necessarily total completion latency.

## Remaining work

Successful completed answers and tool outcomes are persisted as before. Conversation summarization has since moved to a durable background worker ([Background summaries](BACKGROUND_SUMMARIES.md)), and tool availability and round limits are now described in [Coach prompts](COACH_PROMPTS.md).

## Verification

Python: `cd backend && .venv/bin/python -m unittest discover -s tests`

Frontend: `node --import tsx --test tests/chatCache.test.ts tests/chatStream.test.ts`

Interrupt/retry/accordion browser fixture: `/tests/chatControls.browser.html` on
an isolated Vite port (for example 5181). It mocks all requests with synthetic
data and never uses a real account. `node tests/chatControls.browser.cjs` checks
desktop/mobile interactions and saves screenshots under
`/private/tmp/timsgym-interactions`. Set `TEST_BASE_URL`, `PLAYWRIGHT_PATH` and
`BROWSER_CHANNEL=chrome` as needed for the local browser/runtime installation.

The isolated browser fixture at `/tests/chatCache.browser.html` serves mock streaming responses and never calls a real coach. Run it on a separate origin/port to avoid overwriting a real guest cache.
