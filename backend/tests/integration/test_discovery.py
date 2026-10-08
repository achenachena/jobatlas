import httpx
import pytest
from sqlalchemy import func, select

from app.discovery import commoncrawl, pipeline
from app.models import Company, DiscoveryCandidate, DiscoveryWatermark, Source
from tests.unit.test_commoncrawl import BASE, HOST, build_index, range_handler

pytestmark = pytest.mark.integration

GH = "boards-api.greenhouse.io"


def _cand(session, provider, tenant, url):
    session.add(
        DiscoveryCandidate(
            canonical_url=url,
            provider=provider,
            tenant_key=tenant,
            channel="commoncrawl",
            state="new",
            attempts=0,
        )
    )
    session.commit()


def test_verify_registers_live_boards_without_any_typed_company_name(
    session, make_client, fake_web
):
    _cand(session, "greenhouse", "acme", "https://job-boards.greenhouse.io/acme")
    _cand(session, "greenhouse", "gone", "https://job-boards.greenhouse.io/gone")
    _cand(session, "ashby", "someorg", "https://jobs.ashbyhq.com/someorg")
    fake_web.json(GH, "/v1/boards/acme", {"name": "Acme Robotics", "content": ""})
    fake_web.add(GH, "/v1/boards/gone", httpx.Response(404, json={"error": "not found"}))
    fake_web.json(
        "api.ashbyhq.com", "/posting-api/job-board/someorg?includeCompensation=true", {"jobs": []}
    )
    fake_web.add(
        "jobs.ashbyhq.com",
        "/someorg",
        httpx.Response(200, text="<html><head><title>Some Org Jobs</title></head></html>"),
    )

    stats = pipeline.verify_candidates(session, make_client())
    assert stats.rejected == 1
    assert len(stats.accepted_new_source) == 2

    src = session.scalar(select(Source).where(Source.tenant_key == "acme"))
    assert src.discovered_via == "commoncrawl"
    assert src.next_run_at is not None  # initial sync is due immediately
    names = set(session.scalars(select(Company.name)))
    assert names == {"Acme Robotics", "Some Org"}  # from the boards, not typed by anyone
    states = dict(
        session.execute(select(DiscoveryCandidate.tenant_key, DiscoveryCandidate.state)).all()
    )
    assert states == {"acme": "accepted", "gone": "rejected", "someorg": "accepted"}

    # Re-running finds nothing new and creates no duplicates.
    again = pipeline.verify_candidates(session, make_client())
    assert again.checked == 0
    assert session.scalar(select(func.count()).select_from(Source)) == 2


def test_candidates_parked_before_adapter_existed_are_requeued(session, make_client, fake_web):
    session.add(
        DiscoveryCandidate(
            canonical_url="https://jobs.lever.co/acme", provider="lever", tenant_key="acme",
            channel="commoncrawl", state="deferred", rejection_reason="adapter_not_implemented",
            attempts=0,
        )
    )  # fmt: skip
    session.commit()
    fake_web.json("api.lever.co", "/v0/postings/acme?mode=json&skip=0&limit=100", [])
    fake_web.add("jobs.lever.co", "/acme", httpx.Response(200, text="<title>Acme Inc</title>"))
    stats = pipeline.verify_candidates(session, make_client())
    assert len(stats.accepted_new_source) == 1


def test_transient_verification_failure_retries_then_defers(session, make_client, fake_web):
    _cand(session, "greenhouse", "flaky", "https://job-boards.greenhouse.io/flaky")
    fake_web.add(GH, "/v1/boards/flaky", httpx.Response(503))
    for _ in range(pipeline.MAX_VERIFY_ATTEMPTS):
        pipeline.verify_candidates(session, make_client(max_retries=0))
    cand = session.scalar(select(DiscoveryCandidate))
    session.refresh(cand)
    assert cand.state == "deferred" and cand.rejection_reason.startswith("verification_failed")


def test_harvest_resumes_from_watermark(session, make_client, fake_web, monkeypatch):
    monkeypatch.setattr(commoncrawl, "CHUNK", 1024)
    monkeypatch.setattr(commoncrawl, "ATS_SURT_PREFIXES", {"ashby": "com,ashbyhq,jobs)/"})
    monkeypatch.setattr(pipeline, "ATS_SURT_PREFIXES", {"ashby": "com,ashbyhq,jobs)/"})
    cluster, cdx = build_index(50)
    fake_web.add(HOST, f"{BASE}/cluster.idx", range_handler(cluster))
    fake_web.add(HOST, f"{BASE}/cdx-00000.gz", range_handler(cdx))
    fake_web.json("index.commoncrawl.org", "/collinfo.json", [{"id": "CC-MAIN-TEST"}])

    s1 = pipeline.harvest_commoncrawl(session, make_client(), max_blocks=1)
    assert s1.blocks_read == 1
    wm = session.scalar(select(DiscoveryWatermark))
    assert wm.next_block == 1 and wm.completed_at is None

    s2 = pipeline.harvest_commoncrawl(session, make_client(), max_blocks=10)
    session.refresh(wm)
    assert wm.completed_at is not None
    tenants = set(session.scalars(select(DiscoveryCandidate.tenant_key)))
    assert tenants == {"alpha", "beta", "gamma", "delta", "epsilon"}
    assert s1.candidates_new + s2.candidates_new == 5

    s3 = pipeline.harvest_commoncrawl(session, make_client(), max_blocks=10)
    assert s3.blocks_read == 0
