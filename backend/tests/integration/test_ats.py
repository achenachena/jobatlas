"""Employer boards end to end: boards -> sweep -> postings, coverage, release (real PostgreSQL,
mocked platform APIs)."""

from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import pytest
import respx
from sqlalchemy import func, select, update

from app.atlas import ats
from app.atlas.cities import load_places, parse_geonames
from app.atlas.metrics import build_release, current_release, publish
from app.atlas.models import (
    AtlasBoard,
    AtlasCoverage,
    AtlasDailyMetric,
    AtlasPosting,
    AtlasRelease,
    AtlasSource,
)
from app.atlas.permissions import sync_registry
from app.core.timeutil import utcnow

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
DAY3 = datetime(2026, 10, 17, 15, 0, tzinfo=UTC)


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


@pytest.fixture
def swept(seeded):
    """Three daily sweeps: collection starts 2026-10-15 (11:00 Toronto), the last sweep's day
    (10-17) is in progress, so the API serves through 10-16."""
    for day, acme, gamma in ((DAY1, ACME_DAY1, GAMMA_DAY1), (DAY2, ACME_DAY2, GAMMA_DAY2),
                             (DAY3, ACME_DAY2, GAMMA_DAY2)):  # fmt: skip
        with _mock(acme, gamma):
            ats.sweep(seeded, now=lambda day=day: day)
    return seeded


def _by_city(frame):
    return {c["city_id"]: c["count"] for c in frame["cities"]}


def test_ats_api_serves_employer_boards(swept, client):
    rel = current_release(swept, ats.DATASET)
    assert rel.data_through == date(2026, 10, 17)
    caps = client.get("/api/v2/atlas/capabilities", params={"dataset": "ats"}).json()
    assert (caps["dataset_id"], caps["data_mode"], caps["release_id"]) == ("ats", "real", rel.id)
    # the swept day is not over: served through the day before, and nothing is "partial today"
    assert (caps["history_start"], caps["data_through"]) == ("2026-09-15", "2026-10-16")
    assert not caps["partial_latest_day"] and caps["gaps"] == []
    # 30 days rebuilt from open postings plus the first day, observed only from 11:00 on
    assert [(b["start"], b["end"]) for b in caps["backfilled"]] == [("2026-09-15", "2026-10-15")]
    assert caps["refresh"] == "hourly" and caps["publication"].startswith("hourly")
    # acme, beta and gamma have counted postings (oldco is gone)
    assert caps["employers"] == 3 and rel.quality["employers"] == 3
    assert caps["platforms"] == ["Greenhouse", "Ashby", "Lever"]
    assert caps["attribution"] == (
        "Counted from employers' public job boards hosted on Greenhouse, Ashby and Lever. "
        "Not affiliated with these platforms."
    )

    f = client.get("/api/v2/atlas/frame", params={"dataset": "ats"}).json()
    assert (f["dataset_id"], f["date"], f["window"]) == ("ats", "2026-10-16", "7d")
    assert f["completeness"] == "complete" and not f["partial_day"]
    assert f["backfilled_days"] == 6  # 10-10 .. 10-15 of the 10-10 .. 10-16 window
    assert any("backfilled" in n for n in f["notes"])
    assert _by_city(f) == {"ca-on-toronto": 2, "ca-qc-montreal": 1, "ca-ab-calgary": 1}
    one = client.get("/api/v2/atlas/frame", params={"dataset": "ats", "window": "1d"}).json()
    assert one["backfilled_days"] == 0 and not any("backfilled" in n for n in one["notes"])
    first = client.get(
        "/api/v2/atlas/frame", params={"dataset": "ats", "window": "1d", "date": "2026-10-15"}
    ).json()
    assert first["backfilled_days"] == 1
    today = client.get("/api/v2/atlas/frame", params={"dataset": "ats", "date": "2026-10-17"})
    assert today.status_code == 400 and today.json()["error"]["code"] == "DATE_OUT_OF_RANGE"

    tl = client.get("/api/v2/atlas/timeline", params={
        "dataset": "ats", "window": "1d", "start": "2026-10-13"}).json()  # fmt: skip
    assert tl["end"] == "2026-10-16"
    assert [fr["backfilled_days"] for fr in tl["frames"]] == [1, 1, 1, 0]

    s = client.get("/api/v2/atlas/cities/ca-on-toronto/series",
                   params={"dataset": "ats", "window": "1d", "days": 7}).json()  # fmt: skip
    assert [p["date"] for p in s["points"]][-1] == "2026-10-16"
    assert [p["backfilled_days"] for p in s["points"]] == [1, 1, 1, 1, 1, 1, 0]
    assert [p["count"] for p in s["points"]] == [1, 0, 0, 0, 0, 0, 1]

    cities = client.get("/api/v2/atlas/cities", params={"dataset": "ats"}).json()
    assert {c["city_id"] for c in cities["cities"]} == {"ca-on-toronto", "ca-qc-montreal",
                                                        "ca-ab-calgary"}  # fmt: skip
    v = client.get("/api/v2/atlas/version", params={"dataset": "ats"}).json()
    assert (v["dataset_id"], v["release_id"], v["data_through"]) == ("ats", rel.id, "2026-10-16")

    # Job Bank is a separate dataset: still not configured, never filled from Employer boards.
    assert client.get("/api/v2/atlas/frame").status_code == 503
    assert client.get("/api/v2/atlas/version").json()["dataset_id"] == "jobbank"


def test_occupations_are_offered_per_dataset(swept, client, monkeypatch):
    from app.api.routes import atlas as routes

    def ids(dataset):
        caps = client.get("/api/v2/atlas/capabilities", params={"dataset": dataset}).json()
        return [o["id"] for o in caps["occupations"]]

    everything = ids("real")  # Job Bank keeps the full list
    assert len(everything) == len(routes.PUBLIC_IDS) and everything[0] == "all"
    assert ids("ats") == ["all"]  # nothing reaches 20 postings in this small fixture
    # Last 30 days: software development 3 (acme/1, beta/l1, gamma/a2), human resources 1.
    monkeypatch.setattr(routes, "MIN_OCCUPATION_POSTINGS", 2)
    routes._ats_occupations.cache_clear()
    assert ids("ats") == ["all", "software_development"]
    monkeypatch.setattr(routes, "MIN_OCCUPATION_POSTINGS", 1)
    routes._ats_occupations.cache_clear()
    assert ids("ats") == ["all", "software_development", "human_resources"]


def test_a_superseded_release_stays_readable_for_a_day(swept, client):
    r1, r2, r3 = swept.scalars(
        select(AtlasRelease).where(AtlasRelease.dataset_id == ats.DATASET)
        .order_by(AtlasRelease.created_at)).all()  # fmt: skip
    now = utcnow()
    for r, hours in ((r1, 30), (r2, 25), (r3, 10)):
        r.created_at = r.published_at = now - timedelta(hours=hours)
    swept.commit()
    keys = list(ats.SOURCE_KEYS.values())
    for _ in range(2):
        publish(swept, build_release(swept, ats.DATASET, keys))
    # r1 was replaced 25 hours ago: gone. r2 was still current 24 hours ago, so pages bound to
    # it keep working, although it is now the fourth newest.
    assert swept.get(AtlasRelease, r1.id) is None
    frame = "/api/v2/atlas/frame"
    gone = client.get(frame, params={"dataset": "ats", "release": r1.id})
    assert gone.status_code == 404 and gone.json()["error"]["code"] == "RELEASE_NOT_FOUND"
    for r in (r2, r3):
        ok = client.get(frame, params={"dataset": "ats", "release": r.id})
        assert ok.status_code == 200 and ok.json()["release_id"] == r.id
    # a release id of the other dataset is not served under this one
    other = client.get(frame, params={"dataset": "real", "release": r3.id})
    assert other.json()["error"]["code"] == "RELEASE_NOT_FOUND"
