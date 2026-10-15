"""v2 atlas: import, dedup, coverage, atomic releases, admission gate and API semantics."""

import os
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.atlas import jobbank
from app.atlas.cities import CityIndex, load_places, parse_geonames
from app.atlas.metrics import REAL_DATASET, ReleaseError, build_release, publish
from app.atlas.models import AtlasCoverage, AtlasPosting, AtlasSource
from app.atlas.permissions import sync_registry

pytestmark = pytest.mark.integration

HEADER = ["WIC Job Location Snapshot ID", "Job Title", "Original Job Title", "NOC21 Code",
          "External Indicator", "First Posting Date", "Province/Territory", "City",
          "Work Location Postal Code", "Employment Term Telework"]  # fmt: skip
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


def _row(ext, day, city="Toronto", prov="Ontario", noc="21232", title="Software Developer",
         telework="No"):  # fmt: skip
    return [ext, title, title, noc, "0", day, prov, city, "M5V 2T6", telework]


def _file(tmp_path: Path, name: str, rows: list[list[str]]) -> Path:
    p = tmp_path / name
    lines = ["\t".join(HEADER)] + ["\t".join(map(str, r)) for r in rows]
    p.write_text("\n".join(lines) + "\n", encoding="utf-16")
    return p


def _month(start: date, rid: str) -> jobbank.MonthResource:
    return jobbank.MonthResource(start, rid, f"https://open.canada.ca/{rid}.csv", "2026-10-02")


@pytest.fixture
def seeded(session):
    sync_registry(session)
    load_places(session, parse_geonames(PLACES.splitlines()))
    session.commit()
    return CityIndex.build(session)


def _import(session, cities, tmp_path, start, rid, rows):
    path = _file(tmp_path, f"{rid}.csv", rows)
    return jobbank.import_file(session, path, _month(start, rid), "sha", cities)


def test_import_is_idempotent_and_follows_corrections(session, seeded, tmp_path):
    rows = [_row("1", "2026/09/01"), _row("2", "2026/09/02", city="Montréal", prov="Québec"),
            _row("2", "2026/09/02", city="Montréal", prov="Québec"),  # repeated row
            _row("3", "2026/09/03", city="NA", telework="Yes"),
            _row("4", "2026/09/03", city="Nowhere Town")]  # fmt: skip
    r = _import(session, seeded, tmp_path, date(2026, 9, 1), "sep", rows)
    assert (r.rows, r.skipped) == (4, 1)
    statuses = dict(session.execute(
        select(AtlasPosting.external_id, AtlasPosting.geo_status)).all())  # fmt: skip
    assert statuses == {"1": "city", "2": "city", "3": "remote", "4": "unconfirmed"}
    # Re-running the same file adds nothing.
    _import(session, seeded, tmp_path, date(2026, 9, 1), "sep", rows)
    assert session.scalar(select(func.count()).select_from(AtlasPosting)) == 4
    # The publisher corrected the month: posting 4 is gone from its file.
    r = _import(session, seeded, tmp_path, date(2026, 9, 1), "sep", rows[:4])
    assert r.removed == 1
    assert session.scalar(select(func.count()).select_from(AtlasPosting)) == 3


def test_unadmitted_source_cannot_import_or_release(session, seeded, tmp_path):
    session.get(AtlasSource, jobbank.SOURCE_KEY).evidence_ref = None  # flag without evidence
    session.commit()
    with pytest.raises(jobbank.JobBankError):
        _import(session, seeded, tmp_path, date(2026, 9, 1), "sep", [_row("1", "2026/09/01")])
    with pytest.raises(ReleaseError):
        build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY])
    with pytest.raises(ReleaseError):
        build_release(session, REAL_DATASET, ["linkedin"])


@pytest.fixture
def client(engine):
    from app.api.routes import atlas as routes
    from app.core import config
    from app.db import session as dbs

    os.environ["DATABASE_URL"] = os.environ["JOBATLAS_TEST_DATABASE_URL"]
    os.environ.setdefault("REDIS_URL", "redis://localhost:63799/15")
    caches = (
        config.get_settings, dbs.get_sync_engine, dbs._sync_factory, dbs.get_async_engine,
        dbs._async_factory, routes._city_ids, routes._cities, routes.scale_max,
    )  # fmt: skip
    for fn in caches:
        fn.cache_clear()
    from app.api.main import create_app

    with TestClient(create_app()) as c:
        yield c
    for fn in caches:
        fn.cache_clear()


def test_not_configured_is_distinct_and_never_demo(session, seeded, client):
    caps = client.get("/api/v2/atlas/capabilities").json()
    assert caps["data_mode"] == "not_configured" and not caps["playback"]
    r = client.get("/api/v2/atlas/frame")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "DATA_SOURCE_NOT_CONFIGURED"
    assert client.get("/api/v2/atlas/version").json()["data_mode"] == "not_configured"


def _two_months(session, cities, tmp_path):
    aug = [_row(str(i), f"2026/08/{d:02d}") for i, d in enumerate(range(20, 32), start=100)]
    sep = [_row("1", "2026/09/28"), _row("2", "2026/09/29"),
           _row("3", "2026/09/30", noc="64301", title="Bartender"),
           _row("4", "2026/09/30", city="Montréal", prov="Québec", noc="64301", title="Barman"),
           _row("5", "2026/09/30", city="NA"),
           _row("6", "")]  # no trusted date  # fmt: skip
    _import(session, cities, tmp_path, date(2026, 8, 1), "aug", aug)
    _import(session, cities, tmp_path, date(2026, 9, 1), "sep", sep)


def test_release_frames_and_api(session, seeded, tmp_path, client):
    _two_months(session, seeded, tmp_path)
    rel = build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY], change_kind="coverage")
    publish(session, rel)
    assert rel.quality["no_trusted_date"] == 1  # row "6" has no date: excluded, still counted
    # Fixed playback scale stored at build time: Toronto, Aug 25-31, 7 postings in 7 days.
    assert rel.quality["scale_max"]["all"]["7d"] == 7
    assert rel.quality["scale_max"]["all"]["1d"] == 1
    assert rel.quality["scale_max"]["bartender"]["30d"] == 1

    caps = client.get("/api/v2/atlas/capabilities").json()
    assert caps["data_mode"] == "real" and caps["data_through"] == "2026-09-30"
    assert caps["history_start"] == "2026-08-01" and caps["playback"]

    f = client.get("/api/v2/atlas/frame").json()  # default: all, 7d, latest
    assert (f["occupation"], f["window"], f["date"]) == ("all", "7d", "2026-09-30")
    assert f["window_start"].startswith("2026-09-24T00:00:00-04:00")
    assert f["window_end"].startswith("2026-10-01T00:00:00-04:00")
    counts = {c["city_id"]: c["count"] for c in f["cities"]}
    # Toronto: 28, 29, 30 Sep (the window is 24-30 Sep; August rows are outside it).
    assert counts["ca-on-toronto"] == 3 and counts["ca-qc-montreal"] == 1
    assert "ca-ab-calgary" not in counts  # never had a posting in this release: not drawn
    assert f["national"]["total_unique"] == 5  # 4 placed + 1 city unconfirmed
    assert f["national"]["city_unconfirmed"] == 1
    for key in ("dataset_id", "data_mode", "release_id", "metric", "unit", "reporting_timezone",
                "data_through", "generated_at", "source_set_id", "classification_version",
                "completeness", "stale"):  # fmt: skip
        assert key in f

    bart = client.get("/api/v2/atlas/frame", params={"occupation": "bartender"}).json()
    assert {c["city_id"]: c["count"] for c in bart["cities"]}["ca-qc-montreal"] == 1

    # Zero is a real zero inside covered data; outside history the date is rejected.
    early = client.get("/api/v2/atlas/frame", params={"date": "2026-08-03"}).json()
    assert {c["city_id"]: c["count"] for c in early["cities"]}["ca-on-toronto"] == 0
    assert early["completeness"] == "partial"  # window starts before history
    assert client.get("/api/v2/atlas/frame", params={"date": "2026-10-05"}).status_code == 400

    tl = client.get("/api/v2/atlas/timeline",
                    params={"start": "2026-09-20", "end": "2026-09-30"}).json()  # fmt: skip
    assert len(tl["frames"]) == 11 and tl["max_count"] >= 3
    i = tl["city_ids"].index("ca-on-toronto")
    assert [fr["counts"][i] for fr in tl["frames"]][-1] == 3

    s = client.get("/api/v2/atlas/cities/ca-on-toronto/series", params={"days": 14}).json()
    assert s["points"][-1]["count"] == 3

    # Version + ETag; a new release does not move a client pinned to the old one.
    v = client.get("/api/v2/atlas/version")
    etag = v.headers["etag"]
    assert client.get("/api/v2/atlas/version", headers={"If-None-Match": etag}).status_code == 304
    rel2 = build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY])
    publish(session, rel2)
    assert client.get("/api/v2/atlas/version").headers["etag"] != etag
    pinned = client.get("/api/v2/atlas/frame", params={"release": rel.id}).json()
    assert pinned["release_id"] == rel.id

    src = {s["key"]: s for s in client.get("/api/v2/atlas/sources").json()["sources"]}
    assert set(src) == {"jobbank-open-data"}  # registered ATS sources are not shown here
    assert src["jobbank-open-data"]["admitted"]


def test_gap_month_is_missing_not_zero(session, seeded, tmp_path, client):
    _import(session, seeded, tmp_path, date(2026, 7, 1), "jul", [_row("1", "2026/07/15")])
    _import(session, seeded, tmp_path, date(2026, 9, 1), "sep", [_row("2", "2026/09/15")])
    rel = build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY])
    publish(session, rel)
    assert rel.coverage["gaps"][0]["start"] == "2026-08-01"
    f = client.get("/api/v2/atlas/frame", params={"date": "2026-08-15"}).json()
    assert f["completeness"] == "missing"
    assert all(c["count"] is None for c in f["cities"])
    assert f["national"]["total_unique"] is None


def test_failed_month_keeps_previous_data(session, seeded, tmp_path):
    _import(session, seeded, tmp_path, date(2026, 9, 1), "sep", [_row("1", "2026/09/15")])
    jobbank.record_missing(session, _month(date(2026, 9, 1), "sep"), "timeout")
    cov = session.scalar(select(AtlasCoverage))
    assert cov.status == "complete" and "timeout" in cov.note
    assert session.scalar(select(func.count()).select_from(AtlasPosting)) == 1


def test_demo_is_labelled_and_separate(session, seeded, client):
    caps = client.get("/api/v2/atlas/capabilities", params={"dataset": "demo"}).json()
    assert caps["data_mode"] == "demo" and caps["dataset_id"] == "demo-v1"
    f = client.get("/api/v2/atlas/frame", params={"dataset": "demo"}).json()
    assert f["data_mode"] == "demo" and f["partial_day"]
    # Real stays not configured: no silent fallback to demo.
    assert client.get("/api/v2/atlas/frame").status_code == 503
    assert session.scalar(select(func.count()).select_from(AtlasPosting)) == 0


def test_months_without_ids_use_stable_fingerprints(session, seeded, tmp_path):
    # Mid-2024 files: UTF-8, comma separated, no snapshot id column.
    head = [h for h in HEADER if h != "WIC Job Location Snapshot ID"]
    rows = [r[1:] for r in (_row("x", "2024/08/01"), _row("x", "2024/08/01"),
                            _row("y", "2024/08/02", city="Montréal", prov="Québec"))]  # fmt: skip
    path = tmp_path / "aug2024.csv"
    path.write_text(
        "\n".join([",".join(head)] + [",".join(r) for r in rows]) + "\n", encoding="utf-8"
    )
    month = _month(date(2024, 8, 1), "aug24")
    r = jobbank.import_file(session, path, month, "sha", seeded)
    assert r.rows == 3  # two identical advertisements still count as two
    jobbank.import_file(session, path, month, "sha", seeded)  # idempotent
    assert session.scalar(select(func.count()).select_from(AtlasPosting)) == 3
    ids = set(session.scalars(select(AtlasPosting.external_id)))
    assert all(i.startswith("fp:") for i in ids)


def _metrics(session, rid):
    from app.atlas.models import AtlasDailyMetric

    return {
        (m.occupation_id, m.scope, m.city_id, m.day): m.count
        for m in session.scalars(select(AtlasDailyMetric).where(AtlasDailyMetric.release_id == rid))
    }


def test_incremental_release_equals_full_and_counts_late_data_once(session, seeded, tmp_path):
    _two_months(session, seeded, tmp_path)
    first = build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY])
    publish(session, first)
    # Late record for August arrives in a corrected file (plus a replay of September).
    aug = [_row(str(i), f"2026/08/{d:02d}") for i, d in enumerate(range(20, 32), start=100)]
    aug.append(_row("late-1", "2026/08/21", noc="64301", title="Bartender", city="Montréal",
                    prov="Québec"))  # fmt: skip
    _import(session, seeded, tmp_path, date(2026, 8, 1), "aug", aug)
    inc = build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY],
                        changed=[(date(2026, 8, 1), date(2026, 8, 31))])  # fmt: skip
    assert inc.quality["build"] == "incremental"
    publish(session, inc)
    full = build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY])
    assert _metrics(session, inc.id) == _metrics(session, full.id)
    m = _metrics(session, inc.id)
    assert m[("bartender", "city", "ca-qc-montreal", date(2026, 8, 21))] == 1
    # replaying the same file and rebuilding does not grow anything
    _import(session, seeded, tmp_path, date(2026, 8, 1), "aug", aug)
    again = build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY],
                          changed=[(date(2026, 8, 1), date(2026, 8, 31))])  # fmt: skip
    assert _metrics(session, again.id) == m


def test_legacy_tables_are_removed(session):
    from sqlalchemy import text

    tables = set(session.scalars(text("SELECT tablename FROM pg_tables WHERE schemaname='public'")))
    assert not tables.intersection(
        {
            "jobs",
            "sources",
            "job_leads",
            "intake_runs",
            "companies",
            "evidence",
            "discovery_candidates",
            "locations",
        }
    )
    assert {"atlas_postings", "atlas_sources", "atlas_releases"} <= tables
