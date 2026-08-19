# TimsGym — Agent Memory Subsystem Design

Adapts the "Memory-Aware Agent" framework (Oracle + LangChain + OpenAI, 7 memory types) to
TimsGym's stack: **Neon Postgres + pgvector, FastAPI, Gemini**. All 7 memory types are built, but
each is **individually toggleable** so we only pay inference/latency for what's switched on.

> **Decision (2026-08-18):** Hybrid approach — all 7 memory types on Postgres/pgvector, with
> per-type feature flags to disable any that slow down inference.

---

## 1. Why this replaces Oracle cleanly

| Course framework | TimsGym equivalent |
|---|---|
| Oracle DB 23ai vector store | **Neon Postgres + `pgvector`** (already our DB) |
| `langchain_oracledb.OracleVS` | Direct SQL + `pgvector` (no LangChain) |
| HuggingFace `sentence-transformers` embeddings | **Gemini embeddings API** (no model download) |
| OpenAI `gpt-5` tool-calling | **Gemini** `gemini-2.5-flash` (chat) + a model for summaries |
| Oracle SQL (`RETURNING INTO`, tablespaces) | Postgres SQL |

`pgvector` gives us `vector` columns + similarity search (`<->`, `<=>`), which is all the vector
memory types need.

---

## 2. The 7 memory types → Postgres tables

Vector types carry an `embedding vector(768)` column (dimension depends on the Gemini embed model).
Every table is scoped by `user_id` (and `thread_id` where relevant) so memory is per-user.

| # | Memory type | Table | Vector? | Purpose in TimsGym |
|---|---|---|---|---|
| 1 | **Conversational** | `messages` | no | Chat turns; the fix for multi-turn context ("all of them") |
| 2 | **Summary** | `summaries` | yes | Compressed old turns + JIT expand |
| 3 | **Tool log** | `tool_logs` | no | Audit of every tool call (logged workouts, deletes) |
| 4 | **Knowledge base** | `knowledge_base` | yes | *(repurposed)* fitness principles, exercise form cues |
| 5 | **Workflow** | `workflows` | yes | Past multi-step tool sequences |
| 6 | **Entity** | `entities` | yes | Extracted entities (exercises, goals, injuries) |
| 7 | **Toolbox** | `toolbox` | yes | Semantic tool selection (marginal at 7 tools) |

Sketch of the two core tables (mirrors the course's Oracle schema, Postgres-ified):

```sql
CREATE TABLE messages (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL,
  role        TEXT NOT NULL,             -- 'user' | 'assistant' | 'tool'
  content     TEXT NOT NULL,
  summary_id  TEXT,                      -- set once summarized → excluded from active context
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE summaries (
  id           TEXT PRIMARY KEY,         -- short uuid
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id    TEXT,
  description  TEXT,                     -- 8–12 word label
  summary_text TEXT,                     -- the structured summary
  full_content TEXT,                     -- original text, for expand
  embedding    vector(768),
  created_at   TIMESTAMPTZ DEFAULT now()
);
```

---

## 3. Feature flags (the toggle system)

A single config object gates every read/write. Disable a type → its reads/writes become no-ops,
removing its latency (embedding call + vector query) from the turn.

```python
# config.py
class MemoryFlags(BaseSettings):
    conversational: bool = True    # keep on — core continuity
    summary:        bool = True    # keep on — your main goal
    tool_log:       bool = True    # cheap, no embeddings
    knowledge_base: bool = False   # off until we load fitness content
    workflow:       bool = False   # off — little value at 7 tools
    entity:         bool = False   # off — extra LLM call per turn
    toolbox:        bool = False   # off — semantic search over 7 tools is pointless
```

**Latency note:** each *vector* memory read = 1 embedding API call + 1 vector query; `entity` and
`summary`-on-offload also cost an extra LLM call. `conversational` and `tool_log` are plain SQL
(cheap). Recommended default: **conversational + summary + tool_log on**, the rest off — flip others
on to experiment.

---

## 4. Context-window management (the part you care about)

Ported 1:1 from the course, Oracle→Postgres and OpenAI→Gemini:

```
each chat turn:
  1. BUILD context  → read enabled memory types for (user, thread), as partitioned segments
  2. MEASURE        → calculate_context_usage(context)   # token estimate vs model limit
  3. if usage > 80%: OFFLOAD
        → summarize unsummarized messages for the thread (Gemini)
        → store summary row (+ embedding)
        → mark those messages.summary_id = <id>   (they drop out of future context)
        → replace conversation block with a stub + "[Summary ID: xxx] <desc>"
  4. GENERATE        → Gemini call with system context + tools (thinking_budget=0)
  5. PERSIST         → append user+assistant messages; write tool_logs; (opt) workflow/entities
  6. JIT             → expand_summary(id) tool rehydrates originals on demand
```

Two small ports from the helper:
- `calculate_context_usage`: keep the `chars/4` estimate initially; swap to Gemini's
  `count_tokens` for accuracy later. Use Gemini's real context limit, not gpt-5's.
- Summarization prompt (structured headings: Technical / Context / Entities / Actions) → reused
  as-is; just routed to Gemini.

---

## 5. Embeddings

Use Gemini's embedding endpoint (e.g. `text-embedding-004` / current equivalent) via `google-genai`.
One helper `embed(text) -> list[float]`; the `vector(N)` column dimension matches the model's output.
No HuggingFace, no local model download.

---

## 6. Where it lives (folder)

```
backend/app/memory/
  flags.py        # MemoryFlags config
  store.py        # connection + pgvector helpers, embed()
  conversational.py  summary.py  tool_log.py
  knowledge_base.py  workflow.py  entity.py  toolbox.py
  context.py      # calculate_context_usage, offload_to_summary, build_context
  manager.py      # MemoryManager facade — respects flags, used by the agent loop
```

The agent loop (`agent/coach.py`) calls only `MemoryManager`, which checks the flags — so toggling a
type never touches the loop.

---

## 7. Build order (slots into FastAPI plan Phase 2)

- [ ] Enable `pgvector` on Neon; add the 7 tables via a migration
- [ ] `embed()` helper against Gemini; verify vector dimension
- [ ] `messages` + `tool_logs` (no vectors) → wire into the agent loop = multi-turn memory works
- [ ] `summaries` + context management (`calculate_context_usage`, `offload_to_summary`, `expand_summary` tool) = auto-summarization works
- [ ] Remaining vector types (`knowledge_base`, `workflow`, `entity`, `toolbox`) behind flags, default off
- [ ] Flag-tune: measure per-turn latency with each type on/off; set sane defaults

---

## 8. Honest note

For a fitness coach, conversational + summary + tool_log carry ~95% of the value; the other four are
a learning playground (hence default-off). Building them all is a great way to *learn* the framework;
keeping them flag-gated means the shipped app stays fast. This is the right compromise for
"implement the framework, but don't let it slow the coach down."
