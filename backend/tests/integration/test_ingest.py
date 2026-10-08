import copy

import httpx
import pytest
from sqlalchemy import func, select

from app.models import Job, JobEvent, JobSourceRecord, Source, SourceRun
from app.providers.base import BoardInfo
from app.providers.greenhouse import GreenhouseProvider
from app.services.ingest import sync_source
from app.services.sources import acquire_lock, register_source
from tests.conftest import load_fixture

pytestmark = pytest.mark.integration

HOST = "boards-api.greenhouse.io"
LIST = "/v1/boards/stripe/jobs?content=true"


def _source(session) -> Source:
    cand = GreenhouseProvider().recognize("https://job-boards.greenhouse.io/stripe")
    src, _ = register_source(
        session,
        cand,
        BoardInfo(exists=True, company_name="Stripe"),
        discovered_via="seed",
        discovery_url=None,
        discovery_candidate_id=None,
    )
    session.commit()
    return src


def _count(session, model) -> int:
    return session.scalar(select(func.count()).select_from(model))


def test_sync_filters_region_and_is_idempotent(session, make_client, fake_web):
    data = load_fixture("greenhouse_stripe_jobs.json")
    fake_web.json(HOST, LIST, data)
    src = _source(session)

    r1 = sync_source(session, src.id, make_client())
    assert r1.status == "succeeded" and r1.is_complete
    # Toronto x2 and Toronto+mixed are GTA. "US / Canada" (not remote), Dublin and US-only
    # remote are not target-region jobs.
    assert r1.created == 3
    assert r1.skipped_reasons == {"outside_target_region": 3}
    first_seen = {j.id: j.first_seen_at for j in session.scalars(select(Job))}

    r2 = sync_source(session, src.id, make_client())
    assert (r2.created, r2.updated) == (0, 0)
    assert _count(session, Job) == 3
    assert _count(session, JobSourceRecord) == 3
    assert _count(session, JobEvent) == 3  # one first_seen event each, no duplicates
    session.expire_all()
    assert {j.id: j.first_seen_at for j in session.scalars(select(Job))} == first_seen

    job = session.scalar(
        select(Job).join(JobSourceRecord).where(JobSourceRecord.external_id == "8194287")
    )
    assert job.posted_basis == "original" and job.posted_at.isoformat().startswith("2026-10-01")
    assert job.workplace_type == "unknown"
    assert job.location_status == "unverified"
    assert job.is_publishable and job.status == "active"


def test_content_change_updates_same_job(session, make_client, fake_web):
    data = load_fixture("greenhouse_stripe_jobs.json")
    fake_web.json(HOST, LIST, data)
    src = _source(session)
    sync_source(session, src.id, make_client())
    before = session.scalar(
        select(Job).join(JobSourceRecord).where(JobSourceRecord.external_id == "8194287")
    )
    first_seen, job_id = before.first_seen_at, before.id

    changed = copy.deepcopy(data)
    for j in changed["jobs"]:
        if j["id"] == 8194287:
            j["title"] = j["title"] + " (Updated)"
    fake_web.json(HOST, LIST, changed)
    r = sync_source(session, src.id, make_client())
    assert (r.created, r.updated) == (0, 1)
    session.expire_all()
    after = session.get(Job, job_id)
    assert after.title.endswith("(Updated)")
    assert after.first_seen_at == first_seen
    assert _count(session, Job) == 3


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(503, text="unavailable"),
        httpx.Response(429, headers={"retry-after": "1"}),
        httpx.Response(403, text="forbidden"),
        httpx.Response(200, text="<html>not json</html>"),
        httpx.Response(200, json={"unexpected": True}),
    ],
)
def test_failed_fetch_changes_no_job(session, make_client, fake_web, response):
    data = load_fixture("greenhouse_stripe_jobs.json")
    fake_web.json(HOST, LIST, data)
    src = _source(session)
    sync_source(session, src.id, make_client())
    snapshot = {j.id: (j.status, j.last_verified_at) for j in session.scalars(select(Job))}

    fake_web.add(HOST, LIST, response)
    r = sync_source(session, src.id, make_client(max_retries=1))
    assert r.status == "failed"
    session.expire_all()
    assert {j.id: (j.status, j.last_verified_at) for j in session.scalars(select(Job))} == snapshot
    assert all(n == 0 for n in session.scalars(select(JobSourceRecord.consecutive_missing)))
    src = session.get(Source, src.id)
    assert src.failure_count == 1 and src.next_run_at is not None
    run = session.scalar(select(SourceRun).order_by(SourceRun.started_at.desc()))
    assert run.status == "failed" and not run.is_complete


def test_timeout_changes_no_job(session, make_client, fake_web):
    data = load_fixture("greenhouse_stripe_jobs.json")
    fake_web.json(HOST, LIST, data)
    src = _source(session)
    sync_source(session, src.id, make_client())

    def boom(req):
        raise httpx.ConnectTimeout("t", request=req)

    fake_web.add(HOST, LIST, boom)
    r = sync_source(session, src.id, make_client(max_retries=0))
    assert r.status == "failed" and r.error_class == "timeout"
    assert set(session.scalars(select(Job.status))) == {"active"}


def test_missing_counts_only_on_complete_listing_and_never_closes(session, make_client, fake_web):
    data = load_fixture("greenhouse_stripe_jobs.json")
    fake_web.json(HOST, LIST, data)
    src = _source(session)
    sync_source(session, src.id, make_client())

    dropped = copy.deepcopy(data)
    dropped["jobs"] = [j for j in dropped["jobs"] if j["id"] != 8194287]
    # Incomplete (meta.total disagrees): must not count as missing.
    fake_web.json(HOST, LIST, {**dropped, "meta": {"total": len(data["jobs"])}})
    r = sync_source(session, src.id, make_client())
    assert r.status == "partial" and not r.is_complete
    rec = session.scalar(select(JobSourceRecord).where(JobSourceRecord.external_id == "8194287"))
    session.refresh(rec)
    assert rec.consecutive_missing == 0

    # Complete listing without the job: counted, but the job stays active.
    fake_web.json(HOST, LIST, {**dropped, "meta": {"total": len(dropped["jobs"])}})
    r = sync_source(session, src.id, make_client())
    assert r.is_complete
    session.refresh(rec)
    assert rec.consecutive_missing == 1 and rec.first_missing_at is not None
    assert session.get(Job, rec.job_id).status == "active"


def test_missing_apply_url_is_quarantined(session, make_client, fake_web):
    data = load_fixture("greenhouse_stripe_jobs.json")
    bad = copy.deepcopy(data)
    bad["jobs"][0]["absolute_url"] = None
    fake_web.json(HOST, LIST, bad)
    src = _source(session)
    sync_source(session, src.id, make_client())
    job = session.scalar(
        select(Job)
        .join(JobSourceRecord)
        .where(JobSourceRecord.external_id == str(bad["jobs"][0]["id"]))
    )
    assert not job.is_publishable and "apply_url" in job.quarantine_reason


def test_source_lock_prevents_overlap(session, make_client, fake_web):
    fake_web.json(HOST, LIST, load_fixture("greenhouse_stripe_jobs.json"))
    src = _source(session)
    assert acquire_lock(session, src.id, "other-worker")
    r = sync_source(session, src.id, make_client())
    assert r.status == "skipped_locked"
    assert _count(session, SourceRun) == 0
