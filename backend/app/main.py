"""TimsGym Python backend (FastAPI).

Phase 1: the data API (/api/db/*) ported from server.ts, backed by the same
Neon Postgres and Firebase auth. AI + memory come in Phase 2.
"""
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Depends
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .routers import ai as ai_router
from .routers import db as db_router
from .observability import ensure_observability_schema
from .config import settings
from .auth import current_user, is_trace_admin
from .models import User
from .tracing import ensure_trace_schema
from .db import engine
from .memory.summary_jobs import SummaryWorker, ensure_summary_schema

app = FastAPI(title="TimsGym API", version="0.2.0")


@app.on_event("startup")
def start_summary_worker():
    try:
        ensure_trace_schema(engine)
        ensure_summary_schema(engine)
        if settings.SUMMARY_WORKER_ENABLED:
            worker = SummaryWorker(engine)
            worker.start()
            app.state.summary_worker = worker
    except Exception as error:
        print(f'[summary] worker startup failed: {type(error).__name__}')


@app.on_event("shutdown")
def stop_summary_worker():
    worker = getattr(app.state, "summary_worker", None)
    if worker:
        worker.stop()


@app.on_event("startup")
def create_observability_table():
    try:
        ensure_observability_schema()
    except Exception as error:
        # Telemetry must never prevent the application from starting.
        print(f'[observability] schema check failed: {type(error).__name__}')

# Built frontend (vite build -> TimsGym/dist). In prod this one service serves
# both the React app and the API. Override location with DIST_DIR if needed.
DIST = Path(os.environ.get("DIST_DIR", Path(__file__).resolve().parent.parent.parent / "dist"))


@app.get("/api/health")
def health():
    """Liveness probe. Hit via the Vite proxy at http://localhost:5173/api/health."""
    return {
        "status": "ok",
        "service": "fastapi",
        "message": "Python backend is alive 🐍",
    }


@app.get("/api/access")
def app_access(user: User = Depends(current_user)):
    return JSONResponse({"canUseApp": True, "canInspectTraces": is_trace_admin(user.uid)},
                        headers={"Cache-Control": "no-store"})


app.include_router(db_router.router)
app.include_router(ai_router.router)


# --- Serve the built React frontend (production single-service) ---
# API routes are registered above, so they take precedence over this catch-all.
if DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)          # favicon, manifest.json, sw.js, icons (hashed assets are immutable)
        # index.html must never be cached stale, or the browser keeps loading old
        # JS bundles after a redeploy. Always revalidate it.
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})
