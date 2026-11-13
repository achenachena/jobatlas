"""Readiness reports dependency failures and releases Redis connections."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.api.main import create_app
from app.api.routes import health
from app.db.session import get_session


@pytest.mark.parametrize(
    "head,ungrouped,db_error,redis_error,status,expected",
    [
        ("0019", 0, False, False, 200, {"database": "ok", "grouping": "ok", "redis": "ok"}),
        (None, 0, False, False, 503,
         {"database": "no_migrations", "grouping": "ok", "redis": "ok"}),
        ("0019", 2, False, False, 503,
         {"database": "ok", "grouping": "2 cities without a group", "redis": "ok"}),
        ("0019", 0, True, False, 503, {"database": "error:RuntimeError", "redis": "ok"}),
        ("0019", 0, False, True, 503,
         {"database": "ok", "grouping": "ok", "redis": "error:RuntimeError"}),
    ],
)
def test_readiness(head, ungrouped, db_error, redis_error, status, expected):
    session = MagicMock()
    session.scalar.side_effect = (
        RuntimeError("database unavailable") if db_error else [head, ungrouped]
    )
    app = create_app()
    app.dependency_overrides[get_session] = lambda: session
    with patch.object(health.Redis, "from_url") as factory, TestClient(app) as client:
        redis = factory.return_value.__enter__.return_value
        if redis_error:
            redis.ping.side_effect = RuntimeError("redis unavailable")
        response = client.get("/api/v2/health/ready")
        assert response.status_code == status
        assert response.json() == {
            "status": "ok" if status == 200 else "unavailable", "checks": expected,
        }
        factory.return_value.__exit__.assert_called_once()
