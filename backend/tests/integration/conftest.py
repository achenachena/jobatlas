"""Integration tests run against a real PostgreSQL + PostGIS (never SQLite).

Set JOBATLAS_TEST_DATABASE_URL (the compose DB works: a `jobatlas_test` database is created
on demand). Tests are skipped when it is unset.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base

BACKEND = Path(__file__).resolve().parents[2]
URL = os.environ.get("JOBATLAS_TEST_DATABASE_URL")

pytestmark = pytest.mark.integration


def _ensure_database(url: str) -> None:
    u = make_url(url)
    admin = create_engine(u.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        exists = conn.scalar(
            text("SELECT 1 FROM pg_database WHERE datname = :d"), {"d": u.database}
        )
        if not exists:
            conn.execute(text(f'CREATE DATABASE "{u.database}"'))
    admin.dispose()


@pytest.fixture(scope="session")
def engine():
    if not URL:
        pytest.skip("JOBATLAS_TEST_DATABASE_URL not set")
    _ensure_database(URL)
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND,
        env={**os.environ, "DATABASE_URL": URL},
        check=True,
        capture_output=True,
    )
    eng = create_engine(URL)
    yield eng
    eng.dispose()


@pytest.fixture
def session(engine) -> Session:
    tables = [t.name for t in Base.metadata.sorted_tables if t.name != "regions"]
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY CASCADE"))
    s = sessionmaker(engine, expire_on_commit=False)()
    yield s
    s.close()
