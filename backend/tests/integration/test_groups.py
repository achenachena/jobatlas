"""City groups end to end: grouping stored in the database, /cities groups and the region scale
(real PostgreSQL; boundaries are simplified boxes)."""

from collections import defaultdict
from datetime import date

import pytest

from app.atlas import groups, jobbank
from app.atlas.cities import CityIndex, load_places, parse_geonames
from app.atlas.metrics import REAL_DATASET, build_release, publish
from app.atlas.permissions import sync_registry
from tests.integration.test_atlas import _import, _row

pytestmark = pytest.mark.integration

PLACES = "\n".join(
    "\t".join(map(str, r))
    for r in [
        (6167865, "Toronto", "Toronto", "", 43.70, -79.42, "P", "PPLA", "CA", "", "08", "", "",
         "", 2600000),
        (6075357, "Mississauga", "Mississauga", "", 43.58, -79.66, "P", "PPL", "CA", "", "08", "",
         "", "", 700000),
        (6077243, "Montréal", "Montreal", "", 45.51, -73.59, "P", "PPL", "CA", "", "10", "", "",
         "", 1600000),
    ]
)  # fmt: skip
TORONTO_CMA = {
    "properties": {"CMAUID": "535", "CMANAME": "Toronto", "CMATYPE": "B", "PRUID": "35"},
    "geometry": {"type": "Polygon", "coordinates": [[[-80.0, 43.4], [-79.0, 43.4], [-79.0, 44.2],
                                                      [-80.0, 44.2], [-80.0, 43.4]]]},
}  # fmt: skip
SEP = [
    _row("t1", "2026/09/28"), _row("t2", "2026/09/29"), _row("t3", "2026/09/30"),
    _row("m1", "2026/09/29", city="Mississauga"), _row("m2", "2026/09/30", city="Mississauga"),
    _row("m3", "2026/09/30", city="Mississauga"),
    _row("q1", "2026/09/30", city="Montréal", prov="Québec"),
]  # fmt: skip


@pytest.fixture
def released(session, tmp_path):
    """A Job Bank release built and published before any grouping exists."""
    sync_registry(session)
    load_places(session, parse_geonames(PLACES.splitlines()))
    session.commit()
    _import(session, CityIndex.build(session), tmp_path, date(2026, 9, 1), "sep", SEP)
    rel = build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY], change_kind="coverage")
    publish(session, rel)
    return rel


def _store(session, features):
    return groups.store(session, groups.compute(groups.catalogue(session),
                                                groups.parse_areas(features)))  # fmt: skip


def _region_max(client, group_of):
    """The region-total rule applied to every frame of the release's history."""
    tl = client.get("/api/v2/atlas/timeline", params={"start": "2026-09-01"}).json()
    best = city_best = 0
    for fr in tl["frames"]:
        totals: dict[str, int] = defaultdict(int)
        for cid, n in zip(tl["city_ids"], fr["counts"], strict=True):
            if n is not None:
                totals[group_of[cid]] += n
                city_best = max(city_best, n)
        best = max(best, *totals.values(), 0)
    return tl["max_count"], best, city_best


def test_groups_and_region_scale(session, released, client):
    assert released.quality["scale_max"]["all"]["7d"] == 3  # one city's largest week
    before = client.get("/api/v2/atlas/cities").json()
    assert before["grouping_version"] is None and before["groups"] == []
    assert all(c["group_id"] is None for c in before["cities"])
    # without a grouping each city is its own region: the scale is the city scale
    assert client.get("/api/v2/atlas/timeline").json()["max_count"] == 3

    v = _store(session, [TORONTO_CMA])
    cities = client.get("/api/v2/atlas/cities").json()
    assert cities["grouping_version"] == v
    group_of = {c["city_id"]: c["group_id"] for c in cities["cities"]}
    assert group_of == {"ca-on-toronto": "cma-535", "ca-on-mississauga": "cma-535",
                        "ca-qc-montreal": "single-ca-qc-montreal"}  # fmt: skip
    assert cities["groups"] == [
        {"id": "cma-535", "display_name": "Toronto", "official_name": "Toronto", "kind": "cma",
         "provinces": ["ON"], "lat": 43.7, "lon": -79.42, "members": 2},
        {"id": "single-ca-qc-montreal", "display_name": "Montréal", "official_name": None,
         "kind": "single", "provinces": ["QC"], "lat": 45.51, "lon": -73.59, "members": 1},
    ]  # fmt: skip
    attributions = client.get("/api/v2/atlas/sources").json()["attributions"]
    assert (
        "Adapted from Statistics Canada, 2021 Census – Boundary files, census metropolitan areas "
        "and census agglomerations, 2021. This does not constitute an endorsement by Statistics "
        "Canada of this product."
    ) in attributions

    # The published release was built before the grouping: it gets the region scale unrebuilt.
    assert released.quality["group_scale_max"]["grouping_version"] is None
    max_count, region_best, city_best = _region_max(client, group_of)
    assert max_count == region_best == 6 and max_count >= city_best == 3

    # A release built under the grouping stores the same scale.
    rel2 = build_release(session, REAL_DATASET, [jobbank.SOURCE_KEY])
    publish(session, rel2)
    stored = rel2.quality["group_scale_max"]
    assert stored["grouping_version"] == v and stored["values"]["all"]["7d"] == 6
    assert rel2.quality["scale_max"]["all"]["7d"] == 3  # the city scale keeps its meaning
    assert _region_max(client, group_of)[:2] == (6, 6)

    # Recomputing with another result changes the version, and the API follows it.
    v2 = _store(session, [])
    assert v2 != v
    after = client.get("/api/v2/atlas/cities").json()
    assert after["grouping_version"] == v2
    assert {c["group_id"] for c in after["cities"]} == {"cluster-ca-on-toronto",
                                                        "single-ca-qc-montreal"}  # fmt: skip


def test_demo_scale_uses_region_totals(session, released, client):
    _store(session, [TORONTO_CMA])
    group_of = {c["city_id"]: c["group_id"]
                for c in client.get("/api/v2/atlas/cities", params={"dataset": "demo"}).json()
                ["cities"]}  # fmt: skip
    caps = client.get("/api/v2/atlas/capabilities", params={"dataset": "demo"}).json()
    tl = client.get("/api/v2/atlas/timeline", params={
        "dataset": "demo", "start": caps["history_start"], "end": "2023-12-31"}).json()  # fmt: skip
    best = 0
    for fr in tl["frames"]:
        totals: dict[str, int] = defaultdict(int)
        for cid, n in zip(tl["city_ids"], fr["counts"], strict=True):
            if n is not None:
                totals[group_of[cid]] += n
        best = max(best, *totals.values(), 0)
    # the scale covers the whole demo history; this year alone cannot exceed it
    assert tl["max_count"] >= best > max(n or 0 for fr in tl["frames"] for n in fr["counts"])


def test_atlas_groups_command_rescales_kept_releases(session, released, monkeypatch):
    import json

    from typer.testing import CliRunner

    from app.atlas.models import AtlasRelease
    from app.cli import app

    monkeypatch.setattr(groups, "fetch_features", lambda: iter([TORONTO_CMA]))
    out = CliRunner().invoke(app, ["atlas-groups"])
    assert out.exit_code == 0, out.output
    report = json.loads(out.output)
    assert report["groups"] == {"cma": 1, "single": 1} and report["releases_rescaled"] == 1
    session.expire_all()
    stored = session.get(AtlasRelease, released.id).quality["group_scale_max"]
    # Toronto + Mississauga: 3 on 30 Sep (1d), 6 in a week or a month; Montreal is its own region
    assert stored["grouping_version"] == report["grouping_version"]
    assert stored["values"]["all"] == {"1d": 3, "7d": 6, "30d": 6}


def test_readiness_needs_every_city_grouped_and_deploys_group_only_when_needed(
    session, released, client, monkeypatch
):
    import json

    from typer.testing import CliRunner

    from app.cli import app

    def ready():
        r = client.get("/api/v2/health/ready")
        return r.status_code, r.json()["checks"].get("grouping")

    assert ready() == (503, "3 cities without a group")
    fetched = []
    monkeypatch.setattr(groups, "fetch_features", lambda: fetched.append(1) or iter([TORONTO_CMA]))
    run = CliRunner().invoke
    first = json.loads(run(app, ["atlas-groups", "--if-needed"]).output)
    assert first["groups"] == {"cma": 1, "single": 1} and len(fetched) == 1
    assert ready()[1] == "ok"  # (redis may be absent in tests; the grouping check is what counts)
    # every city has a group: a deploy does nothing and reads nothing
    assert json.loads(run(app, ["atlas-groups", "--if-needed"]).output) == {
        "skipped": "every city has a group"}  # fmt: skip
    assert len(fetched) == 1
    # a new catalogue entry is grouped by the next deploy
    load_places(session, parse_geonames(["\t".join(map(str, (
        5907364, "Brampton", "Brampton", "", 43.68, -79.76, "P", "PPL", "CA", "", "08", "", "",
        "", 600000)))]))  # fmt: skip
    session.commit()
    assert ready()[1] == "1 cities without a group"
    json.loads(run(app, ["atlas-groups", "--if-needed"]).output)
    assert len(fetched) == 2 and ready()[1] == "ok"
