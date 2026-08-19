# TimsGym — Deployment Guide

Ship the app as **one container**: FastAPI serves both the API and the built React frontend,
talking to the cloud services you already have (Neon Postgres, Firebase, Gemini).

```
      Browser ──▶ Render Web Service (this app, one URL)
                     │  FastAPI serves React (dist/) + /api/*
                     ├──▶ Neon Postgres   (data + vector memory)
                     ├──▶ Firebase        (Google login verification)
                     └──▶ Gemini API      (AI coach + embeddings)
```

The whole build is defined in the repo's **`Dockerfile`** (Node builds the frontend → Python
serves it), so the host just builds and runs it.

---

## Prerequisites (already done ✅)
- Neon Postgres — live, tables created.
- Firebase project `fitki-505410` — Google sign-in enabled.
- Gemini API key.
- Code packaged as a single service (FastAPI serves `dist/`), Dockerfile written.

## Step 1 — Push the code to GitHub
The new backend + config must be on GitHub for Render to build it. (Secrets are safe: `.env` is
git-ignored.) We commit and push to `Timson1235/TimsGym`.

## Step 2 — Create a Render account
Sign up at [render.com](https://render.com) (free tier is fine to start). Connect your GitHub.

## Step 3 — New Web Service
- **New → Web Service** → pick the `TimsGym` repo.
- Render detects the **Dockerfile** and uses it (Environment: **Docker**).
- Instance type: **Free** to start.
- It will build (~a few minutes) — Node builds the frontend, Python installs deps.

## Step 4 — Environment variables (in the Render dashboard → Environment)
These are the same values from your local `.env` — set them as Render env vars (never in git):

| Key | Value |
|-----|-------|
| `SQL_HOST` | your Neon host (`ep-...aws.neon.tech`) |
| `SQL_USER` | `neondb_owner` |
| `SQL_PASSWORD` | your Neon password |
| `SQL_DB_NAME` | `neondb` |
| `GEMINI_API_KEY` | your Gemini key |
| `FIREBASE_PROJECT_ID` | `fitki-505410` |

(Render sets `$PORT` automatically; the Dockerfile already reads it.)

## Step 5 — Deploy
Render builds + starts it and gives you a public URL, e.g. `https://timsgym.onrender.com`.

## Step 6 — Authorize the live domain in Firebase
So Google login works on the real URL:
- [console.firebase.google.com](https://console.firebase.google.com) → project `fitki-505410`
  → **Authentication → Settings → Authorized domains → Add domain** → your Render hostname
  (e.g. `timsgym.onrender.com`, no `https://`).

## Step 7 — Test the live app
Open the Render URL, log in with Google, log a workout, chat with the coach.

---

## Notes & gotchas
- **Free tier sleeps.** Render free services spin down when idle; the first request after a nap
  takes ~30-60s to wake (same idea as Neon's scale-to-zero). Fine for a personal app; upgrade for
  always-on.
- **Gemini free-tier quota** still applies in production — heavy use will rate-limit (the coach
  degrades gracefully with a "try again" message). Consider a paid Gemini tier for real usage.
- **Config change on deploy:** none needed — the frontend calls `/api/*` on the same origin, which
  is exactly what the single-service setup serves.
- **Alternative hosts:** the Dockerfile is portable — Railway, Fly.io, or Google Cloud Run work the
  same way (connect repo / push image, set the same env vars).
