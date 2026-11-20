# Developer merge verification

November 4, 2026. Reviewed developer base `a534dab` against remote main
`01bc3f3`; the earlier streaming/cache/preview work is already on remote main.

## Fixes

- Reject empty/whitespace-only Claude replies and `tool_use` stop reasons without
  tool blocks as provider errors in both transports. Configured Gemini fallback
  is allowed only before any mutation attempt. No automatic retry or mutation
  replay was added; the original intermittent provider/parser cause is unknown.
- Keep completed workouts with entirely skipped working sets in progression
  evidence. Neither the latest skipped exercise nor an intervening skipped
  session can be bypassed to increase load from older successes. Draft workouts
  remain excluded.

## Offline checks

- Backend unittest suite: 155 passed, including six new regression tests.
- Frontend Node test suite: 12 passed.
- TypeScript check, production build and diff whitespace check: passed.
- Existing warnings remain: large frontend bundle, deprecated test-client
  integration and some unclosed synthetic SQLite connections.

## Synthetic live evaluation

Ignored local report: `backend/evals/results/20261104-103445-f1b309/report.json`.
The run used disposable SQLite fixtures, the existing production streaming loop,
one repetition per case and a $0.25 estimated cap. Estimated total: $0.09157.

| Case | Automated result | Manual review |
| --- | --- | --- |
| ambiguous_logging | Passed, 7/7 | Clarifies barbell versus dumbbell without logging. |
| missing_effort | Failed, 7/8 | Retrieved progression, held the load and made no mutation. The only failed check was `mentions_missing_effort`: the answer says "No effort (RIR/RPE) was recorded", while the heuristic recognizes only missing/unknown/fehlt/unbekannt. Original scoring/report retained. |
| repeat_adapt | Passed, 13/13 | Created the requested preview while preserving the checked weights and set counts. |

The empty-response fault did not reproduce in this live run; injected transport
tests verify its failure handling and mutation replay protection. The answer's
suggestion that one more successful session would likely qualify for a load
increase is not guaranteed: the deterministic engine must reevaluate consecutive
comparable sessions and cannot skip the missing-effort session. This live sample
does not establish scientific accuracy, caching savings or repeatable reliability.

No real account conversations or traces were inspected. Deployed Firebase login,
browser workflows and production background-worker operation were not verified.
