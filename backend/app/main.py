"""TimsGym Python backend (FastAPI).

Phase 1: the data API (/api/db/*) ported from server.ts, backed by the same
Neon Postgres and Firebase auth. AI + memory come in Phase 2.
"""
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .routers import ai as ai_router
from .routers import db as db_router

app = FastAPI(title="TimsGym API", version="0.2.0")

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
