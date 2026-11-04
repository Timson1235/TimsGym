# Small, budgeted agent evaluations

Run from the repository root:

```bash
cd backend
.venv/bin/python -m evals.run
```

This defaults to a **free dry-run**: it lists scenarios, limits and provenance,
without API calls, token counting, database connections or paid inference.
There is no CI hook, automatic schedule or background evaluation.

## Paid opt-in

```bash
# Default edge-case suite, one repetition each; $0.25 run / $0.18 case budgets.
.venv/bin/python -m evals.run --live

# Focus on one difficult case with a smaller run allowance.
.venv/bin/python -m evals.run --live --case repeat_adapt --max-cost 0.10

# Explicitly repeat a previous configuration and compare its report.
.venv/bin/python -m evals.run --live --baseline evals/results/PREVIOUS/report.json

# Cheap control case; not included in the default suite.
.venv/bin/python -m evals.run --live --case log_set --max-cost 0.05
```

A smaller allowance can stop a case before completion. Such a run is **incomplete,
not passed**. Supported explicit model choices are `claude-sonnet-5-5` (default,
matching the app's default) and `claude-haiku-5-5`. There is no automatic cheaper
model substitution, provider fallback, repetition or paid model judge. Different
models require separate explicit runs and are flagged as different settings in
baseline comparisons.

Run from `backend/` so the existing settings loader finds the project `.env` and
`CLAUDE_API_KEY`. No Firebase login, app access-policy change or real account is
needed. The runner calls production `run_chat`, native streaming provider loop,
context builder, memory selection and tool handlers against a **fresh disposable
SQLite database for each case**. It patches only transport instrumentation,
local engine binding, fixed time, provider selection and summary enqueueing.
Background summaries are disabled so they cannot incur uncounted costs.

## Why these cases

The default suite prioritizes behavioral edge cases over a large list of easy
questions:

1. `ambiguous_logging`: barbell and dumbbell overhead presses both exist. The
   coach must clarify and must not mutate the active workout.
2. `missing_effort`: completed repetitions have preserved plans but unknown
   reported effort. The coach must retrieve the progression evidence, hold the
   target and not invent effort or create a workout.
3. `repeat_adapt`: the correct completed full-body workout is older than the
   latest unrelated workout and a newer unfinished full-body draft. A separate
   overhead-press history must be retrieved, an additional press set added,
   working weights and other set counts preserved, and a preview created.

Each database also contains a foreign-account decoy workout. Fixtures contain no
real account records, messages or stored user traces. The cheaper `log_set` and
`general_rir` cases are optional controls. Free mocked regression tests cover the
underlying contracts, negative paths and budget mechanism on every test run.

## Spending controls

- Default estimated run budget **$0.25**, per-case budget **$0.18**; CLI monetary
  allowances cannot exceed $1 in this small runner.
- Before every paid request, use Anthropic's **free token-count endpoint**. Count
  tools, system and full accumulated conversation, add 10% + 64 tokens of margin,
  reserve the most expensive input category (including cache creation), and
  reserve the full allowed output. Refuse the call if it cannot fit.
- Limit input to **12,000 padded tokens** and output to **1,024 tokens/request**,
  six requests/case and twelve requests/run. Input limits also keep Haiku below
  the pricing table's long-context tier.
- Check 90-second case / 180-second run deadlines before requests and on streamed
  text. Each inference connection has at most a 30-second read timeout. These
  are client-side limits, not server-side cancellation guarantees.
- No retries and no provider fallback. Unknown models/pricing, token-count
  failures and missing usage stop the run. Interrupted/missing usage retains the
  full request reservation rather than counting an uncertain request as free.
- Stop the suite after a guard stop or provider error; list all not-run cases.
  Persist the usage ledger before/after inference and a report after each case.

These are **conservative estimate-based guards**, not a provider billing cap.
Token counting is an estimate, interrupted calls may still be billed, and prices
can change. A provider-enforced spend limit must be configured with the provider.
The output limit is deliberately lower than the app's normal 4,096-token limit;
truncations and budget stops are not treated as successful correctness results.

Rates are explicitly versioned **2026-10-23**, for standard global API pricing
and five-minute cache writes, from [Anthropic pricing](https://claude.com/pricing).
Token counting is documented as free in [Anthropic token-counting documentation](https://platform.claude.com/docs/en/build-with-claude/token-counting).
Sonnet 5.5 rates per million tokens: input $2, output $10, cache creation $2.50,
cache read $0.10. Haiku 5.5 at the bounded context size: $0.10, $0.50, $0.125 and
$0.01 respectively. The eval prices are separate from the app UI's existing
hardcoded estimates; the runner does not claim those estimates are corrected.

## Reports

Each opt-in run creates an ignored `backend/evals/results/<run-id>/` folder:

- `report.md`: status, behavioral checks, inference latency, total wall time and
  estimated cost for each case.
- `report.json`: the same information plus first-text latency, per-round token
  categories and cache use, requested/resolved models, termination reasons,
  budget stops, explicit checks and blank manual-review fields.
- `usage.json`: a usage/reservation checkpoint written before and after each
  model request, including requests with unknown final usage.
- `<case>.trace.json` and `<case>.sqlite3`: full **synthetic** trace inputs/outputs,
  tool spans, fixture records and resulting state for manual inspection.

Each result records the Git commit, dirty-tree flag, agent/memory/eval code
fingerprint, prompt version, fixed evaluation date, fixture version, pricing and
budget configuration. No real app trace store is queried. Never reuse an output
directory: previous runs are preserved.

Inference time excludes token preflight; total wall time and first-text latency
include it. Preflight latency is separately recorded. This is a backend evaluation,
not browser/network/rendering latency. Provider prompt-cache state is uncontrolled;
cache reads/writes are recorded so cold and warm runs are not silently equated.

Correctness checks inspect state changes and actual retrieved tool results.
Text checks such as clarification wording are intentionally simple heuristics
and can have false positives/negatives. A failed heuristic needs review, and
passing all checks does **not** prove scientific accuracy or good coaching.
Fill the manual review fields for scientific soundness, clarity and other
observations; doing so incurs no model cost. There is no aggregate scientific
accuracy percentage or unreliable percentile report from three samples.

`--baseline` compares statuses, passed checks, inference/wall times and estimated
cost. Different fixture versions, models, rates or limits are flagged as
incomparable settings. Cost deltas are omitted when usage is unknown. Inspect
actual replies/traces alongside comparisons before accepting a change.

## Free verification

```bash
.venv/bin/python -m unittest tests.test_eval_runner -q
.venv/bin/python -m unittest discover -s tests -q
```

All unit/integration tests use fake token counts and fake streamed model responses;
they do not spend API credit. Tests cover budget refusal before inference,
unknown usage, time/call/token caps, no fallback, isolated real tool workflows,
hard-case assertions, dry-run isolation and report preservation.

## Targeted lightweight leg-session browsing

```bash
.venv/bin/python -m evals.run --live --case leg_session_browse --max-cost 0.10
```

This opt-in case has a neutrally titled legs-only session behind the first page
of newer upper/full-body sessions. The coach must inspect exercise names in
lightweight pages of at most three, follow the real cursor, fetch only the
selected session's full details, and explain its warm-up/working sets, weights,
repetitions, known effort and comments without modifying data. The stored draft
and cross-account decoy must not become the reference. Here, browsing means
searching saved workout records, not browsing the internet.

This case is available separately so the default three-case budget does not grow
automatically. Its checks inspect actual retrieval results, arguments and order,
not just a plausible final answer. Wording checks still need manual review.
The fixture/catalog version is now `edge-smoke-v2.1-leg-browse`; historical reports
remain unchanged, and baseline comparisons flag the different fixture version.
