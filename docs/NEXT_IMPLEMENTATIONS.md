# Next implementations

## Workout-session retrieval foundation

Discussed October 27–28, 2026. Step 1 projections/pagination implemented; persisted summaries and search remain planned.

- Implemented step 1 (October 28): lightweight session projection with IDs, dates, titles, duration, exercise names and short notes, without individual set data; original full records available on request.
- Generate deterministic summaries and structured exercise/movement metadata for completed sessions; refresh after edits and remove after deletion.
- Add account-scoped filtering/text search over those summaries. Consider semantic embeddings later if measured retrieval quality warrants them; no separate vector store is assumed.
- Search returns candidate IDs/summaries. Retrieve original workout records for exact sets, effort and progression; never derive numeric recommendations from summaries or embeddings.
- Implemented step 1: account/filter-scoped cursor pagination beyond ten sessions, returned counts, effective limits, hasMore/nextCursor and marked shortened summary notes. Similarity alone must not be presented as evidence of a user's usual/frequent routine.

## Context engineering candidates

Discussion topics, not implementation commitments. Evaluate with the small suite before accepting changes.

- Implemented step 2 (October 28): request-wide read reuse across direct/batch calls, conservative exact full-workout/set overlap references, mutation-attempt invalidation and provider-fallback reset. Raw trace evidence is retained. No across-request caching or general round compaction. Savings depend on actual repeated reads.
- Round-specific schema selection and compact structured working state, preserving user intent, personal constraints, actions and evidence references.
- Token-aware total input budgeting, whole-message/whole-result selection and explicit omission metadata instead of blind text cuts.
- Protect unresolved plans/corrections across conversation compaction without promoting coach suggestions into user facts.

## Semantic tool routing

Planned candidate; evaluate before adopting.

- Index concise tool descriptions and representative user-query examples with precomputed embeddings; keep authoritative schemas and handlers in the existing registry. No separate vector database is needed at the current tool count.
- Retrieve relevant tools before the first model call and include their full native schemas immediately, aiming to avoid an extra discovery round.
- Account for active-workout state and recent conversation, especially follow-ups such as "do that again"; include supporting capabilities needed for multi-action workflows.
- Keep `discover_tools` available for missed capabilities. Similarity scores are not calibrated confidence, and offering a tool must not force its use or bypass execution validation.
- Compare discovery-only, simple mode/rule-based routing and embedding-based routing with the budgeted evaluation suite. Measure tool coverage, irrelevant schemas, embedding latency/cost, model rounds and outcome correctness before choosing an approach.
