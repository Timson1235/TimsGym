"""Enable pgvector on Neon and create the 5 vector memory tables (3072-dim)."""
import sys
sys.path.insert(0, ".")

from sqlalchemy import text
from sqlmodel import Session

from app.db import engine
from app.memory.store import EMBED_DIM

DDL = [
    "CREATE EXTENSION IF NOT EXISTS vector",
    f"""CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        thread_id TEXT,
        description TEXT,
        summary_text TEXT,
        full_content TEXT,
        embedding vector({EMBED_DIM}),
        created_at TIMESTAMPTZ DEFAULT now()
    )""",
    f"""CREATE TABLE IF NOT EXISTS knowledge_base (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER,
        content TEXT,
        metadata JSONB,
        embedding vector({EMBED_DIM}),
        created_at TIMESTAMPTZ DEFAULT now()
    )""",
    f"""CREATE TABLE IF NOT EXISTS workflows (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER,
        query TEXT,
        steps JSONB,
        final_answer TEXT,
        embedding vector({EMBED_DIM}),
        created_at TIMESTAMPTZ DEFAULT now()
    )""",
    f"""CREATE TABLE IF NOT EXISTS entities (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER,
        name TEXT,
        entity_type TEXT,
        description TEXT,
        embedding vector({EMBED_DIM}),
        created_at TIMESTAMPTZ DEFAULT now()
    )""",
    f"""CREATE TABLE IF NOT EXISTS toolbox (
        id BIGSERIAL PRIMARY KEY,
        tool_name TEXT,
        description TEXT,
        embedding vector({EMBED_DIM}),
        created_at TIMESTAMPTZ DEFAULT now()
    )""",
]

with Session(engine) as s:
    for stmt in DDL:
        s.exec(text(stmt))
    s.commit()
    rows = s.exec(text("select table_name from information_schema.tables "
                       "where table_schema='public' order by table_name")).all()
    print("tables:", [r[0] for r in rows])
    ext = s.exec(text("select extname from pg_extension where extname='vector'")).all()
    print("pgvector installed:", bool(ext))
