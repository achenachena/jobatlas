import json

import httpx
import pytest
from sqlalchemy import func, select

from app.models import Job, JobSourceRecord
from app.providers.base import BoardInfo, SourceCandidate
from app.services.ingest import sync_source
from app.services.sources import register_source
from tests.conftest import FIXTURES

pytestmark = pytest.mark.integration

HOST = "acme.wd3.myworkdayjobs.com"
ROOT = f"https://{HOST}/Careers/"
CXS = "/wday/cxs/acme/Careers/jobs"
JOB_PAGE = (FIXTURES / "workday_td_job.html").read_text()

POSTINGS = [
    {"title": "Engineer A", "externalPath": "/job/Toronto-Ontario/Engineer-A_R_1",
     "locationsText": "TORONTO, Ontario, Canada"},
    {"title": "Engineer B", "externalPath": "/job/Toronto-Ontario/Engineer-B_R_2",
     "locationsText": "TORONTO, Ontario, Canada"},
    {"title": "Banker", "externalPath": "/job/Flourtown-Pennsylvania/Banker_R_3",
     "locationsText": "Flourtown, Pennsylvania"},
]  # fmt: skip


def _setup(fake_web, postings):
    fake_web.add(HOST, "/robots.txt", httpx.Response(200, text="User-agent: *\nAllow: /\n"))

    def listing(req: httpx.Request):
        body = json.loads(req.content)
        page = postings[body["offset"] : body["offset"] + body["limit"]]
        total = len(postings) if body["offset"] == 0 else 0  # Workday quirk
        return httpx.Response(200, json={"total": total, "jobPostings": page})

    fake_web.add(HOST, CXS, listing)
    for p in postings:
        fake_web.add(HOST, "/Careers" + p["externalPath"], httpx.Response(200, text=JOB_PAGE))


def _source(session):
    src, _ = register_source(session, SourceCandidate("workday", ROOT, ROOT),
                             BoardInfo(exists=True, company_name="Acme"), discovered_via="seed",
                             discovery_url=None, discovery_candidate_id=None)  # fmt: skip
    session.commit()
    return src


def _page_requests(fake_web):
    return [r for r in fake_web.requests if "/Careers/job/" in r.url.path]


def test_complete_listing_details_once_then_listing_evidence(session, make_client, fake_web):
    _setup(fake_web, POSTINGS)
    src = _source(session)
    r = sync_source(session, src.id, make_client())
    assert r.is_complete and r.created == 2  # the Pennsylvania job is never fetched
    assert len(_page_requests(fake_web)) == 2
    assert all("Flourtown" not in str(x.url) for x in fake_web.requests)

    before = {j.id: j.last_verified_at for j in session.scalars(select(Job))}
    r = sync_source(session, src.id, make_client())
    assert len(_page_requests(fake_web)) == 2  # no detail re-fetch within the recheck window
    session.expire_all()
    after = {j.id: j.last_verified_at for j in session.scalars(select(Job))}
    assert all(after[k] > before[k] for k in before)  # listing presence verified them

    # Engineer B disappears from the complete listing: counted as missing, not closed.
    _setup(fake_web, [POSTINGS[0], POSTINGS[2]])
    r = sync_source(session, src.id, make_client())
    missing = session.scalar(
        select(func.max(JobSourceRecord.consecutive_missing)).where(
            JobSourceRecord.source_id == src.id
        )
    )
    assert r.is_complete and missing == 1
    assert set(session.scalars(select(Job.status))) == {"active"}


def test_listing_endpoint_disallowed_falls_back_to_sitemap(session, make_client, fake_web):
    fake_web.add(HOST, "/robots.txt",
                 httpx.Response(200, text="User-agent: *\nDisallow: /wday/\n"))  # fmt: skip
    url = f"https://{HOST}/Careers/job/Toronto-Ontario/Engineer-A_R_1"
    sitemap = f"<urlset><url><loc>{url}</loc></url></urlset>"
    fake_web.add(HOST, "/Careers/siteMap.xml", httpx.Response(200, text=sitemap))
    fake_web.add(
        HOST, "/Careers/job/Toronto-Ontario/Engineer-A_R_1", httpx.Response(200, text=JOB_PAGE)
    )
    src = _source(session)
    r = sync_source(session, src.id, make_client())
    assert r.created == 1 and not r.is_complete
    assert not any(CXS in str(x.url) for x in fake_web.requests)


def test_listing_rows_now_details_later(session, make_client, fake_web, monkeypatch):
    from app.providers.workday import WorkdayProvider

    monkeypatch.setattr(WorkdayProvider, "detail_cap_per_run", 1)
    _setup(fake_web, POSTINGS)
    src = _source(session)
    r = sync_source(session, src.id, make_client())
    assert r.created == 2 and len(_page_requests(fake_web)) == 1
    recs = session.scalars(select(JobSourceRecord).order_by(JobSourceRecord.external_id)).all()
    assert sorted(bool(x.detail_fetched_at) for x in recs) == [False, True]
    thin = next(x for x in recs if x.detail_fetched_at is None)
    assert session.get(Job, thin.job_id).posted_basis == "unknown"  # no guessed date

    sync_source(session, src.id, make_client())  # the remaining detail is read now
    session.refresh(thin)
    assert thin.detail_fetched_at is not None
    assert session.get(Job, thin.job_id).posted_basis == "original"
    assert len(_page_requests(fake_web)) == 2
