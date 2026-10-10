import copy
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import func, select

from app.core.timeutil import utcnow
from app.models import Evidence, Job, JobEvent, JobLocation, JobSourceRecord, Location
from app.providers.base import BoardInfo, SourceCandidate
from app.providers.greenhouse import GreenhouseProvider
from app.services import lifecycle
from app.services.geocode import FixedGeocoder, GeocodeResult
from app.services.ingest import sync_source
from app.services.locations import geocode_pending
from app.services.sources import register_source
from tests.conftest import load_fixture
from tests.integration import factories as f

pytestmark = pytest.mark.integration

GH = "boards-api.greenhouse.io"
LIST = "/v1/boards/stripe/jobs?content=true"


def _gh_source(session, tenant="stripe"):
    cand = GreenhouseProvider().recognize(f"https://job-boards.greenhouse.io/{tenant}")
    src, _ = register_source(session, cand, BoardInfo(exists=True, company_name=tenant.title()),
                             discovered_via="seed", discovery_url=None,
                             discovery_candidate_id=None)  # fmt: skip
    session.commit()
    return src


def _age_missing(session, external_id, hours):
    rec = session.scalar(select(JobSourceRecord).where(JobSourceRecord.external_id == external_id))
    rec.first_missing_at = utcnow() - timedelta(hours=hours)
    session.commit()
    return rec


# ------------------------------------------------------------------ lifecycle (D, G, L)


def test_closure_needs_two_complete_misses_and_detail_404(session, make_client, fake_web):
    data = load_fixture("greenhouse_stripe_jobs.json")
    fake_web.json(GH, LIST, data)
    src = _gh_source(session)
    sync_source(session, src.id, make_client())
    dropped = copy.deepcopy(data)
    dropped["jobs"] = [j for j in dropped["jobs"] if j["id"] != 8194287]
    dropped["meta"]["total"] = len(dropped["jobs"])
    fake_web.json(GH, LIST, dropped)
    fake_web.add(GH, "/v1/boards/stripe/jobs/8194287",
                 httpx.Response(404, json={"status": 404, "error": "Job not found"}))  # fmt: skip
    fake_web.json(GH, "/v1/boards/stripe", {"name": "Stripe"})

    sync_source(session, src.id, make_client())  # miss 1
    job = session.scalar(
        select(Job).join(JobSourceRecord).where(JobSourceRecord.external_id == "8194287")
    )
    assert job.status == "active"
    sync_source(session, src.id, make_client())  # miss 2, but < 30 minutes since first miss
    session.refresh(job)
    assert job.status == "active"

    _age_missing(session, "8194287", hours=1)
    r = sync_source(session, src.id, make_client())  # miss 3, > 30 min, detail says closed
    session.refresh(job)
    assert job.status == "closed" and r.closed == 1
    event = session.scalar(
        select(JobEvent).where(JobEvent.job_id == job.id, JobEvent.to_status == "closed")
    )
    assert "Job not found" in event.reason
    assert (
        session.scalar(
            select(Evidence).where(Evidence.entity_id == job.id, Evidence.field == "status")
        )
        is not None
    )

    # Reappears in the listing -> Active again, first_seen kept.
    first_seen = job.first_seen_at
    fake_web.json(GH, LIST, data)
    sync_source(session, src.id, make_client())
    session.refresh(job)
    assert job.status == "active" and job.first_seen_at == first_seen


def test_inconclusive_detail_closes_only_after_three_misses_over_24h(
    session, make_client, fake_web
):
    data = load_fixture("greenhouse_stripe_jobs.json")
    fake_web.json(GH, LIST, data)
    src = _gh_source(session)
    sync_source(session, src.id, make_client())
    dropped = copy.deepcopy(data)
    dropped["jobs"] = [j for j in dropped["jobs"] if j["id"] != 8194287]
    dropped["meta"]["total"] = len(dropped["jobs"])
    fake_web.json(GH, LIST, dropped)
    fake_web.add(GH, "/v1/boards/stripe/jobs/8194287", httpx.Response(503))  # inconclusive
    client = make_client(max_retries=0)
    for _ in range(3):
        sync_source(session, src.id, client)
    _age_missing(session, "8194287", hours=2)
    sync_source(session, src.id, client)
    job = session.scalar(
        select(Job).join(JobSourceRecord).where(JobSourceRecord.external_id == "8194287")
    )
    assert job.status == "active"  # 4 misses but only 2h
    _age_missing(session, "8194287", hours=25)
    sync_source(session, src.id, client)
    session.refresh(job)
    assert job.status == "closed" and "complete listings" in job.close_reason


def test_sudden_empty_listing_is_quarantined(session, make_client, fake_web):
    data = load_fixture("greenhouse_stripe_jobs.json")
    big = copy.deepcopy(data)
    base = big["jobs"][0]
    big["jobs"] = [{**base, "id": 9000 + i, "location": {"name": "Toronto"}} for i in range(25)]
    big["meta"]["total"] = 25
    fake_web.json(GH, LIST, big)
    src = _gh_source(session)
    sync_source(session, src.id, make_client())
    fake_web.json(GH, LIST, {"jobs": [], "meta": {"total": 0}})
    r = sync_source(session, src.id, make_client())
    assert not r.is_complete
    assert set(session.scalars(select(JobSourceRecord.consecutive_missing))) == {0}
    big["jobs"] = big["jobs"][:5]
    big["meta"]["total"] = 5
    fake_web.json(GH, LIST, big)
    r = sync_source(session, src.id, make_client())  # 80% drop: also suspicious
    assert not r.is_complete


def test_freshness_sweep_and_recovery(session):
    c = f.company(session)
    stale = f.job(session, c, verified_ago=timedelta(hours=49))
    fresh = f.job(session, c, verified_ago=timedelta(hours=1))
    session.commit()
    assert lifecycle.freshness_sweep(session) == 1
    session.refresh(stale)
    session.refresh(fresh)
    assert stale.status == "pending_verification" and fresh.status == "active"
    ev = session.scalar(select(JobEvent).where(JobEvent.job_id == stale.id))
    assert ev.to_status == "pending_verification"


def test_job_listed_by_another_source_is_not_closed_by_one_absence(session, make_client, fake_web):
    c = f.company(session)
    s1 = f.source(session, c, tenant="one")
    s2 = f.source(session, c, tenant="two")
    j = f.job(session, c, s1, external_id="77")
    session.add(JobSourceRecord(job_id=j.id, source_id=s2.id, external_id="77",
                                raw_hash="x", consecutive_missing=0))  # fmt: skip
    rec = session.scalar(select(JobSourceRecord).where(JobSourceRecord.source_id == s1.id))
    rec.consecutive_missing = 5
    rec.first_missing_at = utcnow() - timedelta(days=3)
    session.commit()
    fake_web.add(GH, "/v1/boards/one/jobs/77", httpx.Response(503))
    assert lifecycle.process_missing(session, s1.id, None, make_client(max_retries=0)) == 0
    session.refresh(j)
    assert j.status == "active"


# ------------------------------------------------------------------ dedupe


def test_cross_source_merge_on_same_canonical_url_only(session, make_client, fake_web):
    data = load_fixture("greenhouse_stripe_jobs.json")
    fake_web.json(GH, LIST, data)
    a = _gh_source(session, "stripe")
    sync_source(session, a.id, make_client())
    jobs_before = session.scalar(select(func.count()).select_from(Job))

    # Second board publishes one identical posting URL (+ tracking param) and one job with
    # the same title/company/city but a different URL: only the first merges.
    second = copy.deepcopy(data)
    toronto = next(j for j in second["jobs"] if j["id"] == 8194287)
    same = {**toronto, "id": 1, "absolute_url": toronto["absolute_url"] + "&utm_source=x"}
    lookalike = {**toronto, "id": 2, "absolute_url": "https://stripe.com/jobs/search?gh_jid=2"}
    second = {"jobs": [same, lookalike], "meta": {"total": 2}}
    fake_web.json(GH, "/v1/boards/stripe2/jobs?content=true", second)
    b = _gh_source(session, "stripe2")
    r = sync_source(session, b.id, make_client())
    assert (r.merged, r.created) == (1, 1)
    assert session.scalar(select(func.count()).select_from(Job)) == jobs_before + 1


# ------------------------------------------------------------------ locations (E, H, F)


def _ashby_board(fake_web, jobs):
    fake_web.json("api.ashbyhq.com", "/posting-api/job-board/acme?includeCompensation=true",
                  {"jobs": jobs})  # fmt: skip


def _ashby_source(session):
    cand = SourceCandidate("ashby", "acme", "https://jobs.ashbyhq.com/acme")
    src, _ = register_source(session, cand, BoardInfo(exists=True, company_name="Acme"),
                             discovered_via="seed", discovery_url=None,
                             discovery_candidate_id=None)  # fmt: skip
    session.commit()
    return src


HYBRID = {
    "id": "h1", "title": "Data Analyst", "isListed": True, "workplaceType": "Hybrid",
    "location": "Toronto, ON", "jobUrl": "https://jobs.ashbyhq.com/acme/h1",
    "applyUrl": "https://jobs.ashbyhq.com/acme/h1/application",
    "publishedAt": "2026-10-01T12:00:00Z",
    "address": {"postalAddress": {"streetAddress": "100 King St W", "addressLocality": "Toronto",
                                  "addressRegion": "ON", "addressCountry": "Canada"}},
}  # fmt: skip
CITY_ONLY = {
    **HYBRID, "id": "c1", "title": "Accountant",
    "address": {"postalAddress": {"addressLocality": "Toronto", "addressRegion": "ON"}},
}  # fmt: skip


def test_explicit_street_address_becomes_exact_location_only_after_precise_geocode(
    session, make_client, fake_web
):
    _ashby_board(fake_web, [HYBRID, CITY_ONLY])
    src = _ashby_source(session)
    sync_source(session, src.id, make_client())
    hybrid = session.scalar(select(Job).where(Job.title == "Data Analyst"))
    city = session.scalar(select(Job).where(Job.title == "Accountant"))
    assert hybrid.location_status == "unverified"  # associated, but not geocoded yet
    assert (
        session.scalar(
            select(func.count()).select_from(JobLocation).where(JobLocation.job_id == city.id)
        )
        == 0
    )  # fmt: skip  H: city-only never gets a location

    ok = GeocodeResult("ok", "fixed", lon=-79.3832, lat=43.6487, precision="rooftop")
    stats = geocode_pending(session, FixedGeocoder({"100 King St W": ok}))
    assert stats.precise == 1
    session.refresh(hybrid)
    session.refresh(city)
    assert hybrid.location_status == "exact_work_location"
    assert city.location_status == "unverified"


def test_ambiguous_geocode_keeps_unverified(session, make_client, fake_web):
    _ashby_board(fake_web, [HYBRID])
    src = _ashby_source(session)
    sync_source(session, src.id, make_client())
    geocode_pending(session, FixedGeocoder({"100 King": GeocodeResult("ambiguous", "fixed")}))
    job = session.scalar(select(Job))
    session.refresh(job)
    assert job.location_status == "unverified"
    loc = session.scalar(select(Location))
    assert loc.point is None and loc.geocode_error.startswith("ambiguous")


def test_address_change_invalidates_old_link(session, make_client, fake_web):
    _ashby_board(fake_web, [HYBRID])
    src = _ashby_source(session)
    sync_source(session, src.id, make_client())
    moved = copy.deepcopy(HYBRID)
    moved["address"]["postalAddress"]["streetAddress"] = "200 Bay St"
    _ashby_board(fake_web, [moved])
    sync_source(session, src.id, make_client())
    statuses = dict(session.execute(
        select(Location.display_address, JobLocation.verification_status)
        .join(JobLocation, JobLocation.location_id == Location.id)).all())  # fmt: skip
    assert statuses == {
        "100 King St W, Toronto, ON, Canada": "invalidated",
        "200 Bay St, Toronto, ON, Canada": "verified",
    }


def test_null_geocoder_caches_nothing(session, make_client, fake_web):
    from app.services.geocode import NullGeocoder

    _ashby_board(fake_web, [HYBRID])
    src = _ashby_source(session)
    sync_source(session, src.id, make_client())
    stats = geocode_pending(session, NullGeocoder())
    assert stats.skipped_not_configured
    assert session.scalar(select(Location)).geocoded_at is None


def test_conflicting_postal_hint_is_dropped_on_retry(session):
    loc = Location(normalized_address="850 coxwell ave toronto on", precision="unknown",
                   display_address="850 Coxwell Ave, Toronto, ON", postal_code="M5V")  # fmt: skip
    session.add(loc)
    session.commit()
    queries = []

    class HintRefusing:
        name = "stub"

        def geocode(self, address, country_code="ca"):
            queries.append(address)
            if "M5V" in address:  # the job's City Hall postal code: no such address there
                return GeocodeResult("not_found", self.name)
            return GeocodeResult("ok", self.name, lon=-79.33, lat=43.69, precision="street")

    assert geocode_pending(session, HintRefusing()).precise == 1
    assert queries == ["850 Coxwell Ave, Toronto, ON, M5V", "850 Coxwell Ave, Toronto, ON"]
    session.refresh(loc)
    assert loc.point is not None and loc.precision == "street"


def test_unreachable_geocoder_caches_nothing(session):
    loc = Location(normalized_address="1 yonge st toronto on", precision="unknown",
                   display_address="1 Yonge St, Toronto, ON")  # fmt: skip
    session.add(loc)
    session.commit()

    class Down:
        name = "stub"

        def geocode(self, address, country_code="ca"):
            return GeocodeResult("error", self.name, detail="connection refused")

    assert geocode_pending(session, Down()).unusable == {"error": 1}
    session.refresh(loc)
    assert loc.geocoded_at is None and loc.geocode_error is None
