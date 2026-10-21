# Coach retrieval and memory

## Current request path

1. Authenticate the user, then load their profile, exercise library, and saved workouts from Postgres (`crud.get_user_database_state`). Workouts are ordered by training date, creation time, then ID, newest first.
2. Build a compact system context: profile, explicitly saved preferences, open flags, active-session progress, and recent performance for selected main lifts. The entire workout history is **not** put into the model prompt.
3. Add up to 20 recent uncompressed chat messages and the three newest text summaries for this chat. Token-budget estimation triggers optional compaction of older messages; the original rows remain stored.
4. The model chooses tools. History tools filter the account-scoped snapshot in Python; they do not call an embedding model, another LLM, or the database for each lookup. Tool outcomes are returned to the model and recorded in tool logs. The loop allows four model rounds.
5. Persist the chat response and refresh the database state. Browser chat caching only accelerates display; it is not the agent's training-data source.

## Tools

- `get_session_summary(limit, search_title_or_date, include_details)` searches **completed** sessions by normalized title/date, newest first. Generic full-body / Ganzkörper title aliases are recognized. `include_details=true` returns complete structured workouts, avoiding a second tool round.
- `get_workout_details(workout_id)` selects one exact saved workout from the account snapshot. It preserves completion state, warm-up and working sets, effort and notes. An explicit lookup can return an unfinished saved workout; its status is retained.
- `get_exercise_history(exercise_id | exercise_name, limit)` retrieves completed sets for one canonical exercise across completed sessions. IDs take precedence. Names use deterministic normalization and aliases; ambiguous names return candidates rather than choosing the first. Legacy entries without IDs resolve by canonical name.

Limits are bounded to 1–10 sessions. Dates and workout IDs accompany results so recommendations can identify their source. Missing RPE stays missing. Full-body title matching does not infer workout content: if titles do not match, the coach must inspect unfiltered recent workouts and clarify if needed.

## Repeat-and-adapt example

"Another full-body workout like last time, but more overhead press":

1. Retrieve the latest matching completed full-body workout, including details.
2. Independently retrieve overhead-press history, even if that lift is absent from the reference session. Both requests can be issued in one model round when the queries are known.
3. Draft the new session, identifying the reference date/title and distinguishing reference-session volume from the lift's performance in other workouts.
4. Do not treat uncompleted targets as achieved sets or invent a baseline when no history exists.

The retrieval sequence is instructed by the system prompt. It is **not** enforced by an intent classifier or deterministic router; live evaluations should monitor tool selection.

## Performance and future work

Current strengths: no embedding latency for exact training facts, small bounded tool results, compact context, and no redundant detail lookup when the session search returns full details.

Current limits: every chat still loads the user's full training history into the server snapshot, twice across the request path; history tools scan/sort that snapshot. Summary retrieval is chronological, not semantic. Four model rounds may limit complicated workflows. There is no implemented fitness-book RAG or research-search layer.

Next scaling step: indexed, account-scoped SQL queries for bounded recent sessions and exact exercise IDs, rather than loading all history. Keep exact numeric facts in structured records. Add hybrid keyword/vector retrieval and source metadata separately for books, research, and semantic notes. Measure context size, retrieval accuracy and model/tool latency before introducing extra model calls or rerankers.
