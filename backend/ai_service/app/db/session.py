"""Async SQLModel engine (asyncpg) and async session factory."""

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

# pool_pre_ping issues a lightweight liveness check when a connection is checked
# out, transparently replacing ones the DB dropped (Render free-tier Postgres
# closes idle connections) — without it, a stale connection surfaces as an
# asyncpg "connection is closed" InterfaceError. pool_recycle proactively retires
# connections older than the interval so we rarely hand out a soon-to-die one.
engine = create_async_engine(
    settings.database_url,
    future=True,
    pool_pre_ping=True,
    pool_recycle=300,
)

async_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)
