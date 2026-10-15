"""Regression checks: retired collectors cannot return through public routes or schedules."""

from fastapi.testclient import TestClient

from app.api.main import app
from app.atlas.permissions import REGISTRY
from app.workers.celery_app import celery_app


def test_only_jobbank_is_registered_and_scheduled():
    assert {r["key"] for r in REGISTRY} == {"jobbank-open-data"}
    assert {r["task"] for r in celery_app.conf.beat_schedule.values()} == {"jobatlas.atlas_sync"}
    assert celery_app.conf.task_default_queue == "atlas"


def test_retired_api_routes_are_not_accessible():
    with TestClient(app) as client:
        for path in [
            "/api/v1/search",
            "/api/v1/jobs/test",
            "/api/v1/coverage",
            "/api/v1/regions",
            "/api/v1/openapi.json",
        ]:
            assert client.get(path).status_code == 404
        assert client.get("/api/v2/health/live").status_code == 200
    assert not any(p.startswith("/api/v1/") for p in app.openapi()["paths"])
