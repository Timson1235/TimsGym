"""Create the Phase 2b memory tables (only the missing ones)."""
import sys
sys.path.insert(0, ".")

from sqlalchemy import text
from sqlmodel import SQLModel, Session

import app.models  # noqa: F401  (registers all table models)
from app.db import engine

SQLModel.metadata.create_all(engine)  # checkfirst=True -> only creates missing tables

with Session(engine) as s:
    rows = s.exec(
        text("select table_name from information_schema.tables "
             "where table_schema='public' order by table_name")
    ).all()
    print("tables in Neon:", [r[0] for r in rows])
