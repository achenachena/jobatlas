"""Database sessions shared by API handlers, workers and operator commands."""

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings


@lru_cache
def get_sync_engine() -> Engine:
    return create_engine(get_settings().database_url, pool_pre_ping=True)


@lru_cache
def _sync_factory() -> sessionmaker[Session]:
    return sessionmaker(get_sync_engine(), expire_on_commit=False)


@contextmanager
def sync_session() -> Iterator[Session]:
    with _sync_factory()() as session:
        yield session


def get_session() -> Iterator[Session]:
    """FastAPI dependency; sync handlers run in its thread pool."""
    with sync_session() as session:
        yield session
