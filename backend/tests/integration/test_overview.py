"""History overview: prepared replay payloads against the daily frames they summarise (real
PostgreSQL, Job Bank fixture months with a missing April)."""

import gzip
import json
import threading
import time
from datetime import date, timedelta

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.orm import sessionmaker

from app.atlas import jobbank, overview
from app.atlas.datasets import RealDataset
from app.atlas.metrics import REAL_DATASET, build_release, publish
from app.atlas.models import AtlasOverview, AtlasRelease
from app.atlas.occupations import PUBLIC_IDS
from tests.integration.test_atlas import _import, _row, seeded  # noqa: F401

pytestmark = pytest.mark.integration

MONTHS = [1, 2, 3, 5, 6]  # 2026; April is never imported: a coverage gap


def _rows(month: int) -> list[list[str]]:
    first = date(2026, month, 1)
    days = [d for i in range(31) if (d := first + timedelta(days=i)).month == month]
    rows = [_row(f"t{d}", d.strftime("%Y/%m/%d")) for d in days]  # one Toronto posting a day
    if month == 1:  # a Montreal burst on a day the 1-day overview does not sample
        rows += [_row(f"m{i}", "2026/01/02", city="Montréal", prov="Québec") for i in range(5)]
    return rows


@pytest.fixture
def release(session, seeded, tmp_path):  # noqa: F811
    for m in MONTHS:
        _import(session, seeded, tmp_path, date(2026, m, 1), f"m{m}", _rows(m))
    rel = build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY], change_kind="coverage")
    publish(session, rel)
    return rel


def _overview(client, **params):
    r = client.get("/api/v2/atlas/overview", params={"release": params.pop("release", None),
                                                     **params})  # fmt: skip
    assert r.status_code == 200, r.text
    return r


def test_frames_match_the_daily_frames_and_keep_every_city(release, client):
    ov = _overview(client, window="1d").json()
    assert (ov["start"], ov["end"], ov["window"]) == ("2026-01-01", "2026-06-30", "1d")
    dates = [f["date"] for f in ov["frames"]]
    assert dates == sorted(dates) and dates[0] == ov["start"] and dates[-1] == ov["end"]
    # April is not covered: one incomplete stretch, its first day and the day after are frames
    assert [(g["start"], g["end"]) for g in ov["incomplete"]] == [("2026-04-01", "2026-04-30")]
    assert {"2026-04-01", "2026-05-01"} <= set(dates)
    assert len(dates) == overview.SAMPLES + 2
    # every frame is exactly the daily frame of its date
    tl = client.get("/api/v2/atlas/timeline", params={"window": "1d", "start": ov["start"],
                                                     "end": "2026-03-31"}).json()  # fmt: skip
    tl2 = client.get("/api/v2/atlas/timeline", params={"window": "1d", "start": "2026-04-01",
                                                      "end": ov["end"]}).json()  # fmt: skip
    daily = {f["date"]: f for f in tl["frames"] + tl2["frames"]}
    for f in ov["frames"]:
        d = daily[f["date"]]
        counts = dict(zip(tl["city_ids"], d["counts"], strict=True))
        assert f["counts"] == [counts[c] for c in ov["city_ids"]], f["date"]
        for k in ("national", "quality", "days_available", "backfilled_days", "notes"):
            assert f[k] == d[k], (f["date"], k)
    april = next(f for f in ov["frames"] if f["date"] == "2026-04-01")
    assert april["quality"] == "missing" and april["national"] is None
    assert all(c is None for c in april["counts"])
    # Montreal's only postings fall on an unsampled day: its priority still has them
    assert "2026-01-02" not in dates
    city_max = dict(zip(ov["city_ids"], ov["city_max"], strict=True))
    assert city_max == {"ca-on-toronto": 1, "ca-qc-montreal": 5}
    assert ov["scale_max"] == release.quality["scale_max"]["all"]["1d"]


def test_thirty_day_overview_starts_on_a_complete_window(release, client):
    ov = _overview(client).json()
    # the first full 30-day window ends on Jan 30; windows touching April (ending Apr 1 to
    # May 29) are incomplete
    assert (ov["start"], ov["end"]) == ("2026-01-30", "2026-06-30")
    assert [(g["start"], g["end"]) for g in ov["incomplete"]] == [("2026-04-01", "2026-05-29")]
    first = ov["frames"][0]
    assert first["quality"] == "complete" and first["days_available"] == 30
    assert first["national"] == 30 + 5  # national counts, not a sum over drawn cities


def test_stored_once_served_compressed_and_cacheable(session, release, client):
    pinned = _overview(client, release=release.id)
    assert pinned.headers["content-encoding"] == "gzip"
    assert pinned.headers["cache-control"] == "public, max-age=31536000, immutable"
    etag = {"If-None-Match": pinned.headers["etag"]}
    again = client.get("/api/v2/atlas/overview", params={"release": release.id}, headers=etag)
    assert again.status_code == 304
    plain = client.get("/api/v2/atlas/overview", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers and plain.headers["cache-control"] == "no-cache"
    assert json.loads(plain.content) == pinned.json()
    assert session.scalar(select(func.count()).select_from(AtlasOverview)) == 1
    # the overview goes with its release
    session.execute(delete(AtlasRelease).where(AtlasRelease.id == release.id))
    session.commit()
    assert session.scalar(select(func.count()).select_from(AtlasOverview)) == 0


def test_concurrent_first_requests_build_once(engine, release, monkeypatch):
    built = []
    real_build = overview.build

    def slow_build(*args):
        built.append(1)
        time.sleep(0.3)  # long enough for every thread to be waiting on the lock
        return real_build(*args)

    monkeypatch.setattr(overview, "build", slow_build)
    bodies = []

    def request():
        with sessionmaker(engine)() as s:
            bodies.append(overview.get_or_build(RealDataset(s, s.get(AtlasRelease, release.id)),
                                                "all", "30d"))  # fmt: skip

    threads = [threading.Thread(target=request) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(built) == 1 and len(set(bodies)) == 1 and bodies[0] is not None
    assert json.loads(gzip.decompress(bodies[0]))["release_id"] == release.id


def test_prepare_stores_every_occupation_before_publishing(session, release):
    rel = build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY])
    assert overview.prepare(session, rel) == len(PUBLIC_IDS)
    assert overview.prepare(session, rel) == 0  # nothing left to build
    stored = set(session.scalars(select(AtlasOverview.occupation)
                                 .where(AtlasOverview.release_id == rel.id)))  # fmt: skip
    assert stored == set(PUBLIC_IDS)


def test_not_enough_history(session, seeded, tmp_path, client):  # noqa: F811
    _import(session, seeded, tmp_path, date(2026, 6, 1), "jun", [_row("x", "2026/06/10")])
    publish(session, build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY]))
    r = client.get("/api/v2/atlas/overview", params={"window": "30d"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "NOT_ENOUGH_HISTORY"


def test_city_history_covers_the_whole_release(release, client):
    s = client.get("/api/v2/atlas/cities/ca-on-toronto/series",
                   params={"window": "30d", "days": 1000}).json()  # fmt: skip
    assert s["points"][0]["date"] == "2026-01-01" and s["points"][-1]["date"] == "2026-06-30"
    tl = client.get("/api/v2/atlas/timeline", params={"window": "30d", "start": "2026-03-01",
                                                     "end": "2026-03-31"}).json()  # fmt: skip
    i = tl["city_ids"].index("ca-on-toronto")
    by_day = {p["date"]: p for p in s["points"]}
    for f in tl["frames"]:
        assert by_day[f["date"]]["count"] == f["counts"][i]
        assert by_day[f["date"]]["quality"] == f["quality"]
    assert by_day["2026-04-15"]["quality"] == "missing" and by_day["2026-04-15"]["count"] is None
