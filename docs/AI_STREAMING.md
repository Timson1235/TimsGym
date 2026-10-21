# Streaming coach responses and provider caching

## Request path

The main coach sends `POST /api/ai/chat` with `stream: true`. The existing JSON response remains available to older clients that omit this flag.

Authentication and chat ownership are checked before streaming starts. A worker runs the existing synchronous agent loop with its own SQLModel session. A queue transfers events to a FastAPI `StreamingResponse` (SSE), with heartbeat comments during quiet periods. Proxy buffering is disabled through response headers where supported.

Events:

- `status`: user-facing progress (loading context, checking history, executing tools, saving).
- `delta`: incremental assistant text; private model thinking and partial tool arguments are never forwarded.
- `reset`: clear the current draft when a new agent round or fallback begins.
- `final`: the authoritative existing response object, including reply, actions, workout state, usage and trace.
- `error`: terminal failure. The client does not automatically retry because tools may already have changed data.

The browser decodes chunked UTF-8 and SSE frames, renders draft text separately from persisted messages, then replaces it with the confirmed final message. Incomplete streamed drafts are not written into the chat cache.

Claude tool arguments are reassembled and parsed only after complete content blocks. Truncated/interrupted rounds do not execute their tools. A provider failure after an attempted mutation does not replay the request through Gemini. Gemini streaming similarly assembles complete response parts before the agent executes tools.

If a client disconnects, the worker finishes the existing request/persistence but stops buffering events. This is an in-process worker, not a durable background-job service; server termination can still interrupt it. There is no automatic reconnect/replay.

## Prompt caching

The coaching prompt starts with stable general rules, followed by a `=== USER DATA ===` boundary and changing account/session context, time and conversation summaries. User names no longer appear in the static opening sentence.

Claude places explicit `cache_control: {"type":"ephemeral"}` breakpoints on the stable system block and final tool definition. This uses the default five-minute TTL and the provider's eligibility thresholds. No changing user data is marked with a cache breakpoint. Set `CLAUDE_PROMPT_CACHING=false` to disable these breakpoints.

Gemini uses its default implicit caching on supported models. Stable prompt ordering improves eligibility; no paid explicit cache objects are created. Hits are not guaranteed.

Usage retains cache creation/read token counts. The response trace also includes `firstTextMs`, visible in expanded trace details. This measures first emitted text, which may be a preliminary tool-round message, rather than time to completed answer. Streaming improves time to visible output, not necessarily total completion latency.

## Remaining work

Conversation summarization still executes synchronously. Moving it off the response path is separate work. Successful completed answers and tool outcomes are persisted as before. Provider selection, available tools and the four-round limit remain unchanged.

## Verification

Python: `cd backend && .venv/bin/python -m unittest discover -s tests`

Frontend: `node --import tsx --test tests/chatCache.test.ts tests/chatStream.test.ts`

The isolated browser fixture at `/tests/chatCache.browser.html` serves mock streaming responses and never calls a real coach. Run it on a separate origin/port to avoid overwriting a real guest cache.
