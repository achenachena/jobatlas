"""GROUP_SQL (database grouping) must give exactly the groups and order of the pure reference
implementation `group_candidates`, on random data covering every rule: workplace types,
label regions, usable/unusable roles, invalidated links, imprecise points, points inside and
outside the viewport, remote eligibility includes/excludes, and posting-time ties."""

import random
import uuid
from collections import defaultdict
from datetime import timedelta

import pytest
from geoalchemy2.elements import WKTElement
from sqlalchemy import text

from app.core.timeutil import utcnow
from app.models import Evidence, JobEligibilityRegion, JobLocation, Location
from app.services.search import (
    BASE_SQL,
    GROUP_SQL,
    GROUPS,
    BBox,
    Candidate,
    group_candidates,
    region_params,
)
from tests.integration import factories as f

pytestmark = pytest.mark.integration

# The previous implementation's point query (every verified precise point; roles filtered in
# Python), kept here as part of the reference path.
POINTS_SQL = """
SELECT jl.job_id::text AS job_id, l.id::text AS location_id, jl.role,
       ST_X(l.point) AS lon, ST_Y(l.point) AS lat
FROM job_locations jl JOIN locations l ON l.id = jl.location_id
WHERE jl.job_id = ANY(CAST(:ids AS uuid[])) AND jl.verification_status = 'verified'
  AND l.point IS NOT NULL AND l.precision IN ('rooftop', 'street')
"""

DOWNTOWN = BBox(-79.45, 43.62, -79.30, 43.70)
INSIDE = [(-79.38, 43.65), (-79.40, 43.66), (-79.31, 43.69)]
OUTSIDE = [(-79.64, 43.59), (-122.4, 37.8), (-73.98, 40.75), (-79.20, 43.80)]
REGIONS = ["toronto", "mississauga", "gta", "ca-on", "ca-qc", "us", None]
ELIG = ["ca", "ca-on", "gta", "toronto", "mississauga", "us", "ca-qc", "north-america"]


def _point(session, job, rng, role):
    lon, lat = rng.choice(INSIDE if rng.random() < 0.5 else OUTSIDE)
    loc = Location(
        normalized_address=f"addr {uuid.uuid4()}",
        display_address="1 Test St",
        point=WKTElement(f"POINT({lon} {lat})", srid=4326),
        precision=rng.choice(["rooftop", "rooftop", "street", "unknown"]),
    )
    session.add(loc)
    session.flush()
    ev = Evidence(entity_type="job", entity_id=job.id, field="location", observed_at=utcnow(),
                  method="test", confidence="high")  # fmt: skip
    session.add(ev)
    session.flush()
    session.add(
        JobLocation(
            job_id=job.id, location_id=loc.id, role=role, evidence_id=ev.id,
            verification_status="verified" if rng.random() < 0.85 else "invalidated",
        )
    )  # fmt: skip


def _seed(session, n=240, seed=7):
    rng = random.Random(seed)
    c = f.company(session)
    now = utcnow()
    stamps = [now - timedelta(hours=h) for h in (1, 5, 5, 30)] + [None]
    for _ in range(n):
        wp = rng.choice(["on_site", "hybrid", "remote", "unknown"])
        elig = None
        if wp == "remote" and rng.random() < 0.8:
            elig = (
                set(rng.sample(ELIG, rng.randint(0, 2))),
                set(rng.sample(ELIG, 1)) if rng.random() < 0.25 else set(),
            )
        job = f.job(session, c, workplace=wp, region=rng.choice(REGIONS),
                    posted_at=rng.choice(stamps))  # fmt: skip
        if elig:
            for r in elig[0]:
                session.add(JobEligibilityRegion(job_id=job.id, region_id=r,
                                                 include_or_exclude="include"))  # fmt: skip
            for r in elig[1]:
                session.add(JobEligibilityRegion(job_id=job.id, region_id=r,
                                                 include_or_exclude="exclude"))  # fmt: skip
        for _ in range(rng.choice([0, 0, 1, 1, 2])):
            role = rng.choice(["work_site", "work_site", "headquarters", "company_office"])
            _point(session, job, rng, role)
    session.commit()


def _params(session):
    now = utcnow()
    return {
        "window_start": None, "today_date": None, "date_floor": None, "as_of": now,
        "fresh_cutoff": now - timedelta(hours=48), "workplace": "all", "tsq": None, "q": "",
    }  # fmt: skip


def _regions(session):
    rows = session.execute(text("SELECT id, parent_id FROM regions")).all()
    return {r.id: {"parent_id": r.parent_id} for r in rows}


def _reference(session, params, region_id, bbox, regions):
    """The previous Python path: fetch everything, then group_candidates."""
    rows = [r for r in session.execute(text(BASE_SQL), params).all() if r.in_window]
    ids = [str(r.id) for r in rows]
    points, inc, exc = defaultdict(list), defaultdict(set), defaultdict(set)
    for pr in session.execute(text(POINTS_SQL), {"ids": ids}):
        points[pr.job_id].append(dict(pr._mapping))
    for er in session.execute(
        text("SELECT job_id::text AS job_id, region_id, include_or_exclude "
             "FROM job_eligibility_regions WHERE job_id = ANY(CAST(:ids AS uuid[]))"),
        {"ids": ids},
    ):  # fmt: skip
        (inc if er.include_or_exclude == "include" else exc)[er.job_id].add(er.region_id)
    cands = []
    for r in rows:
        rid = str(r.id)
        roles = (
            {"company_office", "headquarters"} if r.workplace_type == "remote" else {"work_site"}
        )
        posted = r.posted_at.timestamp() if r.posted_at else float("-inf")
        cands.append(Candidate(
            rid, r.workplace_type, r.location_region_id, r.eligibility_status,
            (-posted, -r.first_seen_at.timestamp(), rid),
            [p for p in points[rid] if p["role"] in roles], inc[rid], exc[rid],
        ))  # fmt: skip
    parents = {k: v["parent_id"] for k, v in regions.items()}
    groups, _ = group_candidates(cands, region_id, bbox, parents)
    return {g: [c.id for c in groups[g]] for g in GROUPS}


@pytest.mark.parametrize("region_id", ["gta", "toronto", "mississauga", "ca"])
@pytest.mark.parametrize(
    "bbox", [DOWNTOWN, BBox(-130, 30, -60, 50), BBox(-79.9, 43.5, -79.6, 43.7)]
)
def test_sql_grouping_matches_reference(session, region_id, bbox):
    _seed(session)
    params = _params(session)
    regions = _regions(session)
    expected = _reference(session, params, region_id, bbox, regions)
    got = {g: [] for g in GROUPS}
    rows = session.execute(
        text(GROUP_SQL),
        {**params, "w": bbox.west, "s": bbox.south, "e": bbox.east, "n": bbox.north,
         **region_params(regions, region_id)},
    )  # fmt: skip
    for r in rows:
        got[r.grp].append(r.id)
    assert got == expected
    assert sum(map(len, expected.values())) > 20  # the random data really exercises the rules
