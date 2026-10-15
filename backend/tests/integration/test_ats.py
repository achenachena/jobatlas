"""Employer boards end to end: boards -> sweep -> postings, coverage, release (real PostgreSQL,
mocked platform APIs)."""

from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest
import respx
from sqlalchemy import func, select, update

from app.atlas import ats
from app.atlas.cities import load_places, parse_geonames
from app.atlas.metrics import current_release
from app.atlas.models import AtlasBoard, AtlasCoverage, AtlasDailyMetric, AtlasPosting, AtlasSource
from app.atlas.permissions import sync_registry

pytestmark = pytest.mark.integration

PLACES = "\n".join(
    "\t".join(map(str, r))
    for r in [
        (6167865, "Toronto", "Toronto", "", 43.70, -79.42, "P", "PPLA", "CA", "", "08", "", "",
         "", 2600000),
        (6077243, "Montréal", "Montreal", "", 45.51, -73.59, "P", "PPL", "CA", "", "10", "", "",
         "", 1600000),
        (5913490, "Calgary", "Calgary", "", 51.05, -114.08, "P", "PPL", "CA", "", "01", "", "",
         "", 1300000),
    ]
)  # fmt: skip
GH = "https://boards-api.greenhouse.io/v1/boards"
DAY1 = datetime(2026, 10, 15, 15, 0, tzinfo=UTC)
DAY2 = datetime(2026, 10, 16, 15, 0, tzinfo=UTC)


def _gh(*jobs):
    return {"jobs": [{"id": i, "title": t, "company_name": "Acme", "first_published": fp,
                      "location": {"name": where}} for i, t, fp, where in jobs]}  # fmt: skip


def _ashby(*jobs):
    return {"jobs": [{"id": i, "title": t, "isListed": True, "publishedAt": pub,
                      "location": "Calgary", "address": {"postalAddress": {
                          "addressCountry": "Canada", "addressRegion": "Alberta",
                          "addressLocality": "Calgary"}}} for i, t, pub in jobs]}  # fmt: skip


ACME_DAY1 = _gh(
    (1, "Software Engineer", "2026-10-10T09:00:00-04:00", "Toronto, ON"),
    (2, "Account Executive", "2026-10-10T09:00:00-04:00", "San Francisco, CA"),
    (3, "Senior Software Developer", "2026-08-01T09:00:00-04:00", "CA-Toronto; CA-Remote"),
)
ACME_DAY2 = _gh(
    *[(j["id"], j["title"], j["first_published"], j["location"]["name"])
      for j in ACME_DAY1["jobs"]],
    (4, "Recruiter", "2026-10-16T08:00:00-04:00", "Toronto, Canada"),
)  # fmt: skip
LEVER = [
    {"id": "l1", "text": "Backend Developer", "country": "CA", "createdAt": 1791990000000,
     "categories": {"location": "Montreal, Quebec"}},  # 2026-10-14 15:00 UTC
    {"id": "l2", "text": "Sales", "country": "US", "createdAt": 1791990000000,
     "categories": {"location": "Austin, Texas"}},
]  # fmt: skip
GAMMA_DAY1 = _ashby(("a1", "ML Engineer", "2026-10-01T12:00:00+00:00"))
# a1 republished (publishedAt moves) must keep its date; a2 is new and dated when first seen
GAMMA_DAY2 = _ashby(("a1", "ML Engineer", "2026-10-16T12:00:00+00:00"),
                    ("a2", "Full Stack Developer", "2025-01-01T12:00:00+00:00"))  # fmt: skip


@pytest.fixture
def seeded(session, monkeypatch):
    sync_registry(session)
    load_places(session, parse_geonames(PLACES.splitlines()))
    session.commit()
    ats.add_boards(session, [("greenhouse", "acme"), ("greenhouse", "oldco"), ("lever", "beta"),
                             ("ashby", "gamma")], "manual")  # fmt: skip
    session.execute(update(AtlasBoard).values(next_check_at=DAY1))  # due at the simulated time
    session.commit()
    monkeypatch.setattr(
        ats, "time", SimpleNamespace(sleep=lambda s: None, monotonic=__import__("time").monotonic)
    )
    return session


def _mock(acme, gamma):
    m = respx.mock(assert_all_called=False)
    m.get("https://boards-api.greenhouse.io/robots.txt").respond(
        200, text="User-agent: *\nDisallow: /embed/\n"
    )
    m.get("https://api.lever.co/robots.txt").respond(
        200, text="User-agent: *\nAllow: /\nCrawl-delay: 1\n"
    )
    m.get("https://api.ashbyhq.com/robots.txt").respond(401, text="Unauthorized")
    m.get(f"{GH}/acme/jobs").respond(200, json=acme)
    m.get(f"{GH}/oldco/jobs").respond(404, json={"status": 404, "error": "Job not found"})
    m.get("https://api.lever.co/v0/postings/beta?mode=json").respond(200, json=LEVER)
    m.get("https://api.ashbyhq.com/posting-api/job-board/gamma").respond(200, json=gamma)
    return m  # fmt: skip


def _counts(session, rid, scope="city"):
    return {
        (c, d): n
        for c, d, n in session.execute(
            select(AtlasDailyMetric.city_id, AtlasDailyMetric.day, AtlasDailyMetric.count).where(
                AtlasDailyMetric.release_id == rid, AtlasDailyMetric.occupation_id == "all",
                AtlasDailyMetric.scope == scope)
        )
    }  # fmt: skip


def test_sweep_baseline_backfill_and_next_day(seeded):
    session = seeded
    with _mock(ACME_DAY1, GAMMA_DAY1):
        r1 = ats.sweep(session, now=lambda: DAY1)
    assert r1.errors == {} and r1.new_records == 4
    boards = {(b.platform, b.slug): b for b in session.scalars(select(AtlasBoard))}
    assert boards[("greenhouse", "acme")].status == "active"
    assert (
        boards[("greenhouse", "acme")].canada_jobs == 2
        and boards[("greenhouse", "acme")].company == "Acme"
    )
    assert boards[("greenhouse", "oldco")].status == "gone"
    assert boards[("lever", "beta")].canada_jobs == 1
    # job 3 lists one Canadian city and "CA-Remote": counted once, in Toronto
    ext = set(session.scalars(select(AtlasPosting.external_id)))
    assert ext == {"acme/1/ca-on-toronto", "acme/3/ca-on-toronto", "beta/l1/ca-qc-montreal",
                   "gamma/a1/ca-ab-calgary"}  # fmt: skip
    # Coverage: 30 backfilled days, today in progress
    cov = {c.period_start: c.status for c in session.scalars(
        select(AtlasCoverage).where(AtlasCoverage.source_key == "ats-greenhouse"))}  # fmt: skip
    assert min(cov) == date(2026, 9, 15) and max(cov) == date(2026, 10, 15)
    assert set(cov.values()) == {"partial"} and len(cov) == 31

    rel = current_release(session, ats.DATASET)
    assert rel.id == r1.release_id and rel.change_kind == "coverage"
    assert (rel.history_start, rel.data_through) == (date(2026, 9, 15), date(2026, 10, 15))
    assert rel.coverage["gaps"] == [] and rel.coverage["partial"][0]["start"] == "2026-09-15"
    assert _counts(session, rel.id) == {
        ("ca-on-toronto", date(2026, 10, 10)): 1,  # job 3 (2026-08-01) is before coverage
        ("ca-qc-montreal", date(2026, 10, 14)): 1,
        ("ca-ab-calgary", date(2026, 10, 1)): 1,  # Ashby baseline: publishedAt
    }
    assert rel.quality["records"] == 4

    with _mock(ACME_DAY2, GAMMA_DAY2):
        r2 = ats.sweep(session, now=lambda: DAY2)
    assert r2.new_records == 2  # acme/4 and gamma/a2; nothing re-added
    cov = {c.period_start: c.status for c in session.scalars(
        select(AtlasCoverage).where(AtlasCoverage.source_key == "ats-greenhouse"))}  # fmt: skip
    assert cov[date(2026, 10, 15)] == "complete" and cov[date(2026, 10, 16)] == "partial"
    assert cov[date(2026, 10, 14)] == "partial"  # backfilled days stay flagged
    rel2 = current_release(session, ats.DATASET)
    assert rel2.id == r2.release_id and rel2.change_kind == "update"
    counts = _counts(session, rel2.id)
    assert counts[("ca-on-toronto", date(2026, 10, 16))] == 1
    assert counts[("ca-ab-calgary", date(2026, 10, 16))] == 1  # first seen, not 2025
    assert counts[("ca-ab-calgary", date(2026, 10, 1))] == 1  # republish did not move a1
    # the 404 board is not due again until its monthly recheck
    assert r2.fetched.get("greenhouse") == 1


def test_blocked_source_stays_blocked_and_is_not_fetched(seeded):
    session = seeded
    session.get(AtlasSource, "ats-lever").status = "blocked"
    session.commit()
    sync_registry(session)  # the code registry must not silently re-approve it
    session.commit()
    assert session.get(AtlasSource, "ats-lever").status == "blocked"
    with _mock(ACME_DAY1, GAMMA_DAY1):
        r = ats.sweep(session, now=lambda: DAY1)
    assert "lever" not in r.fetched
    assert not session.scalar(select(func.count()).select_from(AtlasPosting)
                              .where(AtlasPosting.source_key == "ats-lever"))  # fmt: skip
    rel = current_release(session, ats.DATASET)
    assert "ats-lever" not in rel.source_set_id
