"""Database engine + session for the same Neon Postgres the Node app uses.

We do NOT create tables here — they already exist (created by Drizzle in the
Node app). Python just connects and maps to them.
"""
from sqlmodel import Session, create_engine

from .config import settings

# pool_pre_ping avoids stale connections after Neon's idle scale-to-zero.
engine = create_engine(settings.database_url, pool_pre_ping=True)


def get_session():
    with Session(engine) as session:
        yield session
