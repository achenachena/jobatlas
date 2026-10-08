"""Public API against real PostGIS + Redis (compose redis, DB 15 for tests)."""

import os
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.core.timeutil import utcnow
from tests.integration import factories as f

pytestmark = pytest.mark.integration

REDIS_URL = os.environ.get("JOBATLAS_TEST_REDIS_URL", "redis://localhost:63799/15")
DOWNTOWN = "-79.45,43.62,-79.30,43.70"


@pytest.fixture(scope="module")
def client(engine):
    from app.api import deps
    from app.core import config
    from app.db import session as dbs

    old = {k: os.environ.get(k) for k in ("DATABASE_URL", "REDIS_URL", "API_RATE_LIMIT_PER_MINUTE")}
    os.environ["DATABASE_URL"] = os.environ["JOBATLAS_TEST_DATABASE_URL"]
    os.environ["REDIS_URL"] = REDIS_URL
    os.environ["API_RATE_LIMIT_PER_MINUTE"] = "100000"
    for fn in (config.get_settings, dbs.get_async_engine, dbs._async_factory, deps._redis):
        fn.cache_clear()
    from app.api.main import create_app

    with TestClient(create_app()) as c:
        yield c
    for k, v in old.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    for fn in (config.get_settings, dbs.get_async_engine, dbs._async_factory, deps._redis):
        fn.cache_clear()


def _ids(body, group):
    return [i["id"] for i in body["groups"][group]["items"]]


def test_b_keyword_variants_time_window_and_consistency(client, session):
    now = utcnow()
    c = f.company(session, "Acme")
    recent = [
        f.job(session, c, title=t, posted_at=now - timedelta(hours=h), point=(-79.38, 43.65))
        for t, h in [
            ("Backend Engineer", 5),
            ("Senior Back-End Engineer", 30),
            ("Software Engineer, Backend", 50),
            ("Backend Software Developer", 60),
        ]
    ]
    old = f.job(session, c, title="Backend Engineer II", posted_at=now - timedelta(days=5),
                point=(-79.38, 43.65))  # fmt: skip
    republished = f.job(session, c, title="Backend Engineer", posted_basis="republished_only")
    unknown_time = f.job(session, c, title="Backend Engineer, Payments")
    closed = f.job(session, c, title="Backend Engineer", posted_at=now, status="closed",
                   point=(-79.38, 43.65))  # fmt: skip
    stale = f.job(session, c, title="Backend Engineer", posted_at=now,
                  verified_ago=timedelta(hours=60), point=(-79.38, 43.65))  # fmt: skip
    other = f.job(session, c, title="Registered Nurse", posted_at=now, point=(-79.38, 43.65))
    session.commit()

    r = client.get("/api/v1/search", params={"q": "Backend Engineer", "time_window": "3d",
                                             "bbox": DOWNTOWN})  # fmt: skip
    assert r.status_code == 200, r.text
    body = r.json()
    got = set(_ids(body, "in_view"))
    assert got == {str(j.id) for j in recent}
    for excluded in (old, republished, unknown_time, closed, stale, other):
        assert str(excluded.id) not in str(body["groups"])
    warn = {w["code"]: w for w in body["warnings"]}
    assert warn["UNTRUSTED_POSTING_TIME_EXCLUDED"]["count"] == 2  # republished + unknown
    # Map and list come from the same snapshot.
    assert {feat["properties"]["job_id"] for feat in body["map"]["features"]} == got
    assert body["counts"]["in_view"] == len(got) == body["map_meta"]["unique_job_count"]

    # Typo tolerance via trigram.
    r = client.get("/api/v1/search", params={"q": "Bakend Engineer", "bbox": DOWNTOWN})
    assert str(recent[0].id) in _ids(r.json(), "in_view")


def test_h_e_f_groups_and_detail(client, session):
    c = f.company(session, "Globex")
    exact = f.job(session, c, title="Hybrid Analyst", workplace="hybrid", point=(-79.38, 43.65))
    toronto_only = f.job(session, c, title="Accountant", region="toronto")
    remote_us = f.job(session, c, title="Remote Dev", workplace="remote", region=None,
                      point=(-122.4, 37.79), role="headquarters",
                      eligibility=({"ca-on"}, set()))  # fmt: skip
    remote_unknown = f.job(session, c, title="Remote Mystery", workplace="remote", region=None)
    session.commit()

    body = client.get("/api/v1/search", params={"bbox": DOWNTOWN}).json()
    assert _ids(body, "in_view") == [str(exact.id)]
    assert _ids(body, "remote_elsewhere") == [str(remote_us.id)]
    assert _ids(body, "location_unverified") == [str(toronto_only.id)]
    assert str(remote_unknown.id) not in str(body["groups"])
    assert body["counts"] == {"total": 3, "in_view": 1, "remote_elsewhere": 1,
                              "location_unverified": 1}  # fmt: skip
    # H: no marker for the city-only job anywhere
    unverified_item = body["groups"]["location_unverified"]["items"][0]
    assert unverified_item["markers"] == [] and unverified_item["location_status"] == "unverified"
    # F: remote card carries the company point for "move map to company"
    remote_item = body["groups"]["remote_elsewhere"]["items"][0]
    assert remote_item["markers"][0]["role"] == "headquarters"
    assert remote_item["location_status"] == "company_location"

    # Workplace filter: unknown is in All only; explicit types exclude it.
    hy = client.get("/api/v1/search", params={"bbox": DOWNTOWN, "workplace": "hybrid"}).json()
    assert hy["counts"]["total"] == 1

    d = client.get(f"/api/v1/jobs/{exact.id}").json()
    assert d["location_status"] == "exact_work_location"
    assert d["locations"][0]["role"] == "work_site" and d["locations"][0]["coordinates"]
    assert d["is_open_opportunity"] and d["apply_url"].startswith("https://")
    d = client.get(f"/api/v1/jobs/{remote_us.id}").json()
    assert d["eligibility"]["regions"] == [{"id": "ca-on", "name": "Ontario",
                                            "include_or_exclude": "include"}]  # fmt: skip
    assert d["eligibility"]["note"]


def test_k_pagination_map_completeness_and_expiry(client, session):
    c = f.company(session)
    jobs = [f.job(session, c, title=f"Cook {i}", point=(-79.38 + i * 1e-3, 43.65))
            for i in range(5)]  # fmt: skip
    session.commit()
    body = client.get("/api/v1/search", params={"bbox": DOWNTOWN, "limit": 2}).json()
    assert len(body["groups"]["in_view"]["items"]) == 2
    assert len(body["map"]["features"]) == 5  # map not limited to the first page
    seen = _ids(body, "in_view")
    cursor = body["groups"]["in_view"]["next_cursor"]
    while cursor:
        p = client.get(f"/api/v1/search/{body['search_id']}/jobs",
                       params={"cursor": cursor, "limit": 2}).json()  # fmt: skip
        seen += [i["id"] for i in p["items"]]
        cursor = p["next_cursor"]
    assert sorted(seen) == sorted(str(j.id) for j in jobs) and len(seen) == len(set(seen))

    # A job closes mid-pagination -> snapshot invalid, never shown as open.
    body = client.get("/api/v1/search", params={"bbox": DOWNTOWN, "limit": 2}).json()
    target = body["groups"]["in_view"]["next_cursor"]
    for j in jobs:
        j.status = "closed"
    session.commit()
    r = client.get(f"/api/v1/search/{body['search_id']}/jobs", params={"cursor": target})
    assert r.status_code == 410 and r.json()["error"]["code"] == "SEARCH_EXPIRED"
    assert r.json()["request_id"]

    # Cursor from another search is rejected.
    other = client.get("/api/v1/search", params={"bbox": DOWNTOWN}).json()
    r = client.get(f"/api/v1/search/{other['search_id']}/jobs", params={"cursor": target})
    assert r.status_code in (410, 422)


@pytest.mark.parametrize(
    "params,code",
    [
        ({"bbox": "170,10,-170,20"}, "BBOX_CROSSES_ANTIMERIDIAN"),
        ({"bbox": "1,2,3"}, "INVALID_BBOX"),
        ({"q": "x" * 101}, "VALIDATION_ERROR"),
        ({"limit": 500}, "VALIDATION_ERROR"),
        ({"time_window": "1y"}, "VALIDATION_ERROR"),
        ({"region_id": "atlantis"}, "UNKNOWN_REGION"),
    ],
)
def test_m_invalid_input(client, session, params, code):
    r = client.get("/api/v1/search", params=params)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == code and r.json()["request_id"]


def test_closed_and_quarantined_details(client, session):
    c = f.company(session)
    closed = f.job(session, c, status="closed")
    hidden = f.job(session, c)
    hidden.is_publishable = False
    session.commit()
    d = client.get(f"/api/v1/jobs/{closed.id}").json()
    assert d["status"] == "closed" and not d["is_open_opportunity"] and d["apply_url"] is None
    assert client.get(f"/api/v1/jobs/{hidden.id}").status_code == 404
    assert client.get("/api/v1/jobs/not-a-uuid").status_code == 422


def test_regions_and_coverage(client, session):
    r = client.get("/api/v1/regions", params={"q": "missis"}).json()
    assert r["items"][0]["region_id"] == "mississauga" and r["items"][0]["approximate"]
    gta = client.get("/api/v1/regions", params={"q": "toronto"}).json()["items"]
    assert gta[0]["region_id"] == "gta"
    cov = client.get("/api/v1/coverage").json()
    assert "limitations" in cov and "jobs" in cov


def test_region_switch_changes_eligibility_scope(client, session):
    c = f.company(session)
    toronto_job = f.job(session, c, title="Barista", region="toronto")
    session.commit()
    miss = client.get("/api/v1/search", params={"region_id": "mississauga"}).json()
    assert str(toronto_job.id) not in str(miss["groups"])
    gta = client.get("/api/v1/search", params={"region_id": "gta"}).json()
    assert str(toronto_job.id) in _ids(gta, "location_unverified")
