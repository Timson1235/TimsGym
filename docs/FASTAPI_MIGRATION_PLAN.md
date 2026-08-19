# TimsGym → FastAPI Backend Migration Plan

**Goal:** Move the "brain" of the app (the AI agent, the analytics math, the API) out of the
TypeScript `server.ts` monolith and into a clean **Python / FastAPI** backend — where you're
strongest as a data scientist — while keeping the React frontend and the Neon database exactly
as they are. Add **proper conversation memory** to the agent along the way.

**Guiding principle:** *Incremental and always-working.* We never have a broken app for more than
a few minutes. Each phase ports one slice, verifies it, then retires the old code.

---

## 1. Target architecture

```
        NOW (one process)                     TARGET (two processes)

  ┌───────────────────────────┐        ┌──────────────┐     ┌───────────────────────┐
  │  server.ts (Express)      │        │  Vite dev    │     │  FastAPI (Python)     │
  │  • serves React UI        │        │  serves the  │     │  • REST API /api/*    │
  │  • REST API /api/*        │  ───►  │  React UI    │────►│  • Firebase auth      │
  │  • Firebase auth          │        │  (port 5173) │ /api│  • DB (SQLModel)      │
  │  • Postgres (Drizzle)     │        └──────────────┘     │  • AI agent + tools   │
  │  • Gemini agent           │              ▲              │  • analytics (pandas) │
  └───────────────────────────┘              │             │  • conversation memory│
                                          React calls       └───────────┬───────────┘
                                          /api/* (proxied)              │
                                                                        ▼
                                                                  Neon Postgres
                                                                (same DB, same tables)
```

The frontend keeps calling `/api/...` exactly as it does today. In dev, **Vite proxies** those
calls to FastAPI, so there's no CORS and **`src/lib/api.ts` barely changes**.

---

## 2. What changes vs. what stays

| Stays the same ✅ | Changes 🔧 | Goes away ❌ |
|---|---|---|
| React frontend (`src/components/*`, `App.tsx`) | `vite.config.ts` — add a dev **proxy** to FastAPI | `server.ts` (the whole Express backend) |
| `src/types.ts` (TS types) | `package.json` dev script → just `vite` | Node backend deps (express, drizzle, pg, firebase-admin, @google/genai) |
| Neon Postgres + its 4 tables | New `backend/` Python project | `gym_database.json` guest fallback (optional to keep) |
| Firebase project & login flow | `src/lib/api.ts` — base URL only (or nothing, via proxy) | `tsx`, esbuild server build |
| `.env` values (DB, Gemini, Firebase) | `.env` also read by Python (pydantic-settings) | |

**Key reassurance:** the database already exists (Drizzle created the tables). Python just
*connects* to the same Neon DB — no data migration, no re-creating tables.

---

## 3. Proposed folder structure

```
TimsGym/
├── src/                     # React frontend — UNCHANGED
├── index.html
├── vite.config.ts           # + proxy /api → localhost:8000
├── package.json             # dev = "vite"
│
├── backend/                 # NEW — the Python brain
│   ├── app/
│   │   ├── main.py          # FastAPI app + router registration
│   │   ├── config.py        # settings from .env (pydantic-settings)
│   │   ├── db.py            # SQLModel engine + session dependency
│   │   ├── models.py        # ORM models mirroring schema.ts (users, profiles, exercises, workouts, messages)
│   │   ├── schemas.py       # Pydantic request/response shapes
│   │   ├── auth.py          # verify Firebase token → current_user dependency
│   │   ├── routers/
│   │   │   ├── db.py        # /api/db/*   (workouts, exercises, profile)
│   │   │   └── ai.py        # /api/ai/*   (chat, suggest-weight)
│   │   └── agent/
│   │       ├── tools.py     # the 7 tools: schema + Python handler each
│   │       ├── coach.py     # the agent loop + conversation memory
│   │       └── analytics.py # 1RM/PR/progression math (testable, pandas-friendly)
│   ├── requirements.txt     # or pyproject.toml
│   └── tests/               # pytest — unit-test the analytics + tools
│
└── docs/FASTAPI_MIGRATION_PLAN.md   # this file
```

---

## 4. Python tech stack

| Concern | Choice | Why |
|---|---|---|
| Web framework | **FastAPI + uvicorn** | Async, typed, auto-docs at `/docs`. The standard. |
| DB / ORM | **SQLModel** | SQLAlchemy + Pydantic in one, by FastAPI's author. Beginner-friendly; models double as schemas. |
| Settings | **pydantic-settings** | Reads the same `.env`; typed config, fails loudly if a var is missing. |
| Auth | **firebase-admin** (Python) | Same `verify_id_token` as Node — only needs the project ID. |
| AI | **google-genai** (Python) | Same Gemini API, same `gemini-2.5-flash` + `thinking_budget=0`. (Swapping to Claude later = one module.) |
| Analytics | **pandas / numpy** | Your home turf — progression trends, volume, plots. |
| Tests | **pytest** | Unit-test the PR math and tool handlers. |

---

## 5. How the two run together in dev

Two terminals (or one script):

```bash
# Terminal 1 — the Python brain
cd backend
uvicorn app.main:app --reload --port 8000

# Terminal 2 — the React UI
npm run dev        # (now just `vite`, port 5173)
```

`vite.config.ts` gets a proxy so the frontend's existing `/api/...` calls reach FastAPI:

```ts
server: {
  proxy: { '/api': 'http://localhost:8000' }
}
```

Result: open `http://localhost:5173`, the UI calls `/api/...`, Vite forwards to FastAPI. No CORS,
no frontend rewrite. FastAPI also auto-serves interactive API docs at `http://localhost:8000/docs`.

---

## 6. The key subsystems (sketches, not final code)

**Auth dependency** — verify the Firebase token on protected routes:

```python
# auth.py
from fastapi import Depends, HTTPException, Header
from firebase_admin import auth

async def current_user(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing token")
    try:
        decoded = auth.verify_id_token(authorization.split(" ")[1])
        return get_or_create_user(decoded["uid"], decoded.get("email"))
    except Exception:
        raise HTTPException(401, "Invalid token")
```

**Analytics** — the PR math, now testable Python (currently hand-written JS in `server.ts`):

```python
# analytics.py
def epley_1rm(weight: float, reps: int) -> float:
    return round(weight * (1 + reps / 30))     # unit-testable, no server needed
```

**Agent with memory** — the loop, now stateful across turns:

```python
# coach.py
def chat(user, message: str, history: list) -> Reply:
    context = build_context(user)              # profile, PRs, recent workouts
    contents = history + [user_msg(message)]   # <-- the missing memory: prior turns included
    resp = gemini.generate(contents, system=context, tools=TOOLS, thinking_budget=0)
    if resp.function_calls:
        for call in resp.function_calls:
            TOOLS[call.name].handler(user, call.args)   # execute against Neon
    save_messages(user, message, resp.text)    # persist to `messages` table
    return resp
```

**Conversation memory** — a new `messages` table (user_id, role, content, created_at). Each chat
request loads the last ~10 messages for context and appends the new turn. That's what fixes the
"delete logs → all of them" failure.

---

## 7. Migration phases (incremental checklist)

- [x] **Phase 0 — Scaffold (nothing breaks).** ✅ DONE 2026-08-18. `backend/` FastAPI app +
      venv + `/api/health`; Vite proxy added; verified React (`:5173`) reaches FastAPI (`:8000`)
      through the proxy. Run with `npm run dev:api` (Python) + `npm run dev:web` (Vite). Express
      server.ts on `:3000` untouched.
- [x] **Phase 1 — Port the data API.** ✅ DONE 2026-08-18. `/api/db/*` recreated in FastAPI
      (SQLModel → same Neon DB) with Firebase auth. Verified in browser on `:5173`: login token
      verified, `GET /api/db → 200`, real data served by Python. **Auth gotcha:** Python
      `firebase-admin.verify_id_token` demands a service-account credential (threw
      `DefaultCredentialsError`); switched to `google-auth`'s `verify_firebase_token` (public-cert
      + audience check, project-id only — like Node). Express `:3000` still up for the AI coach
      until Phase 2.
- [ ] **Phase 2 — Port the agent + add memory.** Recreate `/api/ai/chat` in Python: the 7 tools,
      their handlers, the Gemini call (`gemini-2.5-flash`, `thinking_budget=0`), and the full
      **memory subsystem** — see [MEMORY_SUBSYSTEM.md](./MEMORY_SUBSYSTEM.md) (7 memory types on
      Postgres/pgvector, feature-flagged, with automatic summarization + JIT expand). Verify chat +
      each tool action + follow-up context.
- [ ] **Phase 3 — Port analytics.** Move `/api/ai/suggest-weight` and the PR/1RM logic into
      `analytics.py`, with pytest tests. Verify PRs still update on save.
- [ ] **Phase 4 — Retire Node backend.** Delete `server.ts`; trim `package.json` (dev = `vite`,
      remove backend deps). Update the README/run instructions.
- [ ] **Phase 5 — (later) Deploy.** Frontend as static build; FastAPI as a container. Covered in
      a separate deployment plan when you're ready to publish.

Each phase is independently testable and reversible.

---

## 8. Open decisions to make before Phase 1

1. **AI provider:** keep **Gemini** (like-for-like, lowest risk during migration) or switch the
   agent to **Claude**? *Recommendation: keep Gemini for the migration; swapping is a one-module
   change afterward.*
2. **Conversation memory storage:** ✅ DECIDED — full memory subsystem, all 7 types on
   Postgres/pgvector, feature-flagged. See [MEMORY_SUBSYSTEM.md](./MEMORY_SUBSYSTEM.md).
3. **Guest mode:** keep the `gym_database.json` fallback for logged-out users, or make login
   required? *Recommendation: drop guest mode in the Python backend to simplify; the app already
   has real login.*
4. **Running both servers:** two terminals, or a one-command dev script (e.g. a small script that
   launches uvicorn + vite together)? *Recommendation: start with two terminals; add a combined
   script once it's stable.*

---

## 9. First concrete step (Phase 0)

When you're ready: create the Python environment and a hello-world FastAPI that the React app can
reach through the Vite proxy. That proves the two-process setup end-to-end before we move any real
logic. Everything after that is porting one slice at a time.
