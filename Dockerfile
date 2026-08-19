# ---------- Stage 1: build the React frontend ----------
FROM node:22-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build          # vite build -> /build/dist

# ---------- Stage 2: Python backend that serves API + the built frontend ----------
FROM python:3.12-slim
WORKDIR /app

# Install Python deps first (better layer caching)
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Backend code + the built frontend
COPY backend ./backend
COPY --from=frontend /build/dist ./dist

ENV DIST_DIR=/app/dist
ENV PYTHONUNBUFFERED=1
WORKDIR /app/backend

# Hosts (Render/Railway/Fly) inject $PORT; default 8000 for local `docker run`.
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
