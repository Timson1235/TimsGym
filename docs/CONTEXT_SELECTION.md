# Experimental context selection

Branch: `experiment/context-selection`, based on local `developer`, including
the interrupt/retry and active-workout accordion commit.
Claude uses this prototype when `CLAUDE_CONTEXT_SELECTION=true` (default on this
experimental branch). Set false to restore the baseline. Gemini does not perform
context selection. No new model service, database schema or frontend is required.

Each offered Claude tool accepts an optional `_context` input. The transport
validates and removes it before invoking the existing tool handler. This lets
the current model select the next round's view alongside a useful tool call,
without a dedicated context-planning call:

```json
{
  "workout_id": "selected-workout-id",
  "_context": {
    "history": "recent",
    "results": [
      {"call_id": "previous-tool-use-id", "mode": "summary",
       "summary": "Selected workout X from these candidates."}
    ],
    "tools": ["get_workout_details", "start_workout_session"]
  }
}
```

`history` supports all, recent (four historical messages plus the current user
request), or current. The system instruction, including profile, constraints,
summary and active state, is never removed. Relevant constraints in omitted chat
messages are NOT automatically extracted; selection remains a quality risk.

Only earlier read-only results may be summarized. The request-local original
exchange archive stays intact, so selecting `mode: full` restores exact data
without another database read. Call/result IDs and message order remain intact.
Mutation exchanges, including their arguments and outcomes, cannot be compacted.
Model summaries are marked as model notes, not authoritative source evidence.
Context-control inputs are removed from subsequent conversation views.

Tool selection filters already activated capabilities; it cannot activate new
tools or authorize sibling calls. discover_tools stays available and discovered
tools join the next selection. Normal discovery validation, user scoping,
mutation/fallback guards, round limits and interruption still apply. Invalid
context instructions reject the associated tool before execution.

Session browsing guidance now requests lightweight candidates before fetching
one selected workout. Full read feedback replaces legacy cross-result references
in this mode, preventing dangling read-* refs after compaction. Database read
deduplication remains enabled. If Claude falls back to Gemini, that request also
uses full feedback, avoiding references to Claude-only evidence.

Private model spans capture the actual selected payload; round trace steps record
contextCharacters for comparison. Full original tool output remains in existing
private tool traces. Nothing is persisted as a new cross-request cache.

## Verification and limits

Synthetic tests cover reduced subsequent payloads, exact restoration, current
request retention, schema filtering, mutation protection, malformed controls,
raw-feedback isolation and no additional planning round. These are mocked
provider tests, not proof that Claude reliably chooses useful compactions.

No paid live evaluation has been run for this experiment. Compare the same
synthetic requests with the flag true/false, checking correctness, total tokens,
cost and latency. Context schemas add overhead; changing schemas/prefixes may
reduce prompt-cache hits. Savings are not guaranteed. There is no automatic hard
context budget or automatic compaction when the model omits `_context` yet.
Whole results are selectable; per-item batch pruning is a possible next step.
No UI changes or deployment are part of this experiment.
