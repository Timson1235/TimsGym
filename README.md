# TimsGym

Personal fitness coaching and workout logging: React/TypeScript frontend, FastAPI
backend, Firebase sign-in and Neon Postgres persistence. Claude is the primary
coach when configured; Gemini provides the configured fallback.

**Start here:** [developer and AI handover](docs/HANDOVER.md).
Agent contributors must also read [AGENTS.md](AGENTS.md).

## Local development

Install Node dependencies with `npm ci`. Create the Python environment:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
```

Configure the root `.env` using `.env.example` and
`backend/app/config.py`. Database settings are `SQL_HOST`, `SQL_USER`,
`SQL_PASSWORD`, `SQL_DB_NAME`; authentication and provider settings are described
in the handover. Never commit credentials.

```bash
npm run dev
# Optional alternative API port (Vite proxy follows API_PORT):
API_PORT=8001 npm run dev
```

The frontend normally opens at http://localhost:5173; the API defaults to port
8000. See `/api/health` through the frontend proxy. The app requires configured
services and an allowed Firebase account; it has no implicit guest/demo mode.

## Checks

```bash
npm run lint
npm run build
cd backend
.venv/bin/python -m unittest discover -s tests -q
.venv/bin/python -m evals.run
```

The last command is a free evaluation dry-run. Paid runs require explicit
`--live`; read [evaluation guidance](docs/SMALL_EVALUATIONS.md) first.
