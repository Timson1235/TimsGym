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
exchange archive stays intact. Selecting `mode: full` prioritizes exact data
within the read budget; repeating an original read retrieves its cached data
without another database read. Call/result IDs and order remain intact.
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
contextCharacters and contextBudget (read characters before/after, limit and
compacted-result count) for comparison. Full original tool output remains in existing
private tool traces. Nothing is persisted as a new cross-request cache.

## Automatic fallback after the failed manual trial

The first manual trial grew to eight rounds and 119,486 total tokens: Claude
never used `_context`. Optional selection alone was insufficient. The revised
backend enforces these behaviors even when the model ignores context controls:

- A 12,000-character aggregate budget for read-result contents. This is not a
  token budget for the whole prompt. System, current request, historical chat,
  tool-call arguments and mutation receipts are not silently truncated.
- Newest distinct results are preferred; explicit full retention gets priority
  but cannot bypass the budget. Older/oversized results become marked incomplete
  excerpts or small receipts. The original archive remains available. Narrow a
  large read to one workout/exercise when its full result cannot fit.
- Identical results share one latest copy; earlier receipts identify that call.
  Discovery output retains activated names rather than repeated schema guidance.
- The final response-only round omits tool schemas entirely.
- suggest_weight returns lastPerformance using the existing canonical,
  completed-outcome history projection. Missing setup does not hide actual sets;
  actual sets are not progression targets. Its date can differ from progression's
  sourceDate when the latest exercise was fully skipped.

This does not force a shorter investigation or remove all schemas in ordinary
rounds. It enforces smaller read context and removes a reason for extra history
calls. Incomplete excerpts must never be treated as exhaustive evidence.

## Verification and limits

Synthetic tests cover reduced subsequent payloads, exact restoration, current
request retention, schema filtering, mutation protection, malformed controls,
raw-feedback isolation and no additional planning round. These are mocked
provider tests, not proof that Claude reliably chooses useful compactions.
An eight-round regression with no `_context` inputs checks at least a 20% reduction
in total serialized request characters versus the same scripted baseline, even
including schema overhead. This is not a measured token or dollar reduction.
Other regressions enforce the budget, preserve mutations and chat constraints,
restore bounded exact reads, deduplicate results, and preserve unknown effort,
exercise identity, set types and incomplete-set exclusion in lastPerformance.

No controlled paid synthetic comparison has been run for this revision. Compare the same
synthetic requests with the flag true/false, checking correctness, total tokens,
cost and latency. Context schemas add overhead; changing schemas/prefixes may
reduce prompt-cache hits. Savings and fewer model rounds are not guaranteed.
Whole results are selectable; per-item batch pruning is a possible next step.
No UI changes or deployment are part of this experiment.
