"""Search: one query snapshot -> three mutually exclusive groups + map projection
(DEVELOPMENT.md §4, §9).

    in_view              verified point inside bbox (remote: also eligible for region)
    remote_elsewhere     remote, eligible for region, verified company point outside bbox
    location_unverified  no usable point; label region within target region (non-remote)
                         or remote eligibility covers the region

All groups share keyword / time / workplace / open-status / freshness filters and one `as_of`.
The map is the in_view part of the same result: every usable point, never just the first
list page. Over SEARCH_MAX_MAP_POINTS the server aggregates the FULL point set into grid
cells (mode=clusters) rather than sending a truncated sample.

Grouping runs in the database (GROUP_SQL): keyword/time/workplace filters, remote
eligibility for the region, "has a usable point" and the viewport test are all SQL, so Python
only receives (id, group) rows in final order plus the coordinates of the jobs that actually
get a marker. `group_candidates` is the pure reference implementation of the same rules (unit-
tested, and compared against GROUP_SQL on random data in the integration tests).

The ordered ids per group are stored in Redis (packed 16-byte UUIDs) for
SEARCH_SNAPSHOT_TTL_SECONDS; pages are read from the snapshot so map and list never disagree.
A page containing a job that is no longer open invalidates the snapshot (410 SEARCH_EXPIRED)
instead of showing it as current.
"""

from __future__ import annotations

import base64
import json
import math
import re
import secrets
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from datetime import time as dtime
from typing import Any, Literal

from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.timeutil import TORONTO, utcnow
from app.services.region_match import PARENT, covers, is_within

TimeWindow = Literal["today", "24h", "2d", "3d", "7d", "30d", "all"]
Workplace = Literal["all", "on_site", "hybrid", "remote"]
GROUPS = ("in_view", "remote_elsewhere", "location_unverified")
WINDOWS = {
    "24h": timedelta(hours=24),
    "2d": timedelta(days=2),
    "3d": timedelta(days=3),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}
MAX_Q = 100
SYNONYMS: dict[str, list[str]] = {
    "backend": ["back <-> end"],
    "frontend": ["front <-> end"],
    "fullstack": ["full <-> stack"],
    "dev": ["developer"],
    "developer": ["dev", "engineer"],
    "eng": ["engineer"],
    "engineer": ["developer"],
    "swe": ["software <-> engineer"],
    "sr": ["senior"],
    "senior": ["sr"],
    "jr": ["junior"],
    "junior": ["jr"],
    "pm": ["product <-> manager"],
    "rn": ["registered <-> nurse"],
    "qa": ["quality <-> assurance"],
    "ml": ["machine <-> learning"],
    "csr": ["customer <-> service"],
}


class SearchError(Exception):
    def __init__(self, code: str, message: str, status: int):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


@dataclass(frozen=True)
class BBox:
    west: float
    south: float
    east: float
    north: float

    @classmethod
    def parse(cls, raw: str) -> BBox:
        try:
            w, s, e, n = (float(x) for x in raw.split(","))
        except ValueError as exc:
            raise SearchError("INVALID_BBOX", "bbox must be west,south,east,north", 422) from exc
        if not all(math.isfinite(v) for v in (w, s, e, n)):
            raise SearchError("INVALID_BBOX", "bbox values must be finite", 422)
        if not (-180 <= w <= 180 and -180 <= e <= 180 and -90 <= s <= 90 and -90 <= n <= 90):
            raise SearchError("INVALID_BBOX", "bbox out of range", 422)
        if s >= n:
            raise SearchError("INVALID_BBOX", "south must be less than north", 422)
        if w >= e:
            raise SearchError(
                "BBOX_CROSSES_ANTIMERIDIAN",
                "bbox crossing the antimeridian (west >= east) is not supported",
                422,
            )
        return cls(w, s, e, n)

    def contains(self, lon: float, lat: float) -> bool:
        return self.west <= lon <= self.east and self.south <= lat <= self.north


@dataclass
class SearchParams:
    q: str | None
    region_id: str
    bbox: BBox | None
    time_window: TimeWindow = "all"
    workplace: Workplace = "all"
    zoom: float | None = None
    limit: int = 30


# ---------------------------------------------------------------- keyword handling


def build_tsquery(q: str) -> str | None:
    """Tokens are restricted to [a-z0-9+#], so the result is safe tsquery syntax."""
    tokens = re.findall(r"[a-z0-9+#]+", q.lower().replace("-", ""))[:8]
    if not tokens:
        return None
    parts = []
    for tok in tokens:
        tok = re.sub(r"[+#]", "", tok) or tok
        if not tok:
            continue
        alts = [f"{tok}:*", *SYNONYMS.get(tok, [])]
        parts.append("(" + " | ".join(alts) + ")")
    return " & ".join(parts) or None


# ---------------------------------------------------------------- pure grouping core


@dataclass
class Candidate:
    id: str
    workplace_type: str
    location_region_id: str | None
    eligibility_status: str
    sort_key: tuple
    points: list[dict] = field(default_factory=list)  # usable points for this job
    includes: set[str] = field(default_factory=set)
    excludes: set[str] = field(default_factory=set)


def within(region_id: str | None, target: str, parents: dict[str, str | None]) -> bool:
    cur = region_id
    seen = 0
    while cur is not None and seen < 20:
        if cur == target:
            return True
        cur = parents.get(cur)
        seen += 1
    return False


def group_candidates(
    cands: list[Candidate], region_id: str, bbox: BBox, parents: dict[str, str | None]
) -> tuple[dict[str, list[Candidate]], dict[str, list[dict]]]:
    """Returns (groups, in-view points by job id). Pure; unit-tested directly."""
    groups: dict[str, list[Candidate]] = {g: [] for g in GROUPS}
    view_points: dict[str, list[dict]] = {}
    for c in cands:
        remote = c.workplace_type == "remote"
        eligible = remote and covers(c.includes, c.excludes, region_id)
        if remote and not eligible:
            continue  # unknown or other-region eligibility is never shown as GTA-applicable
        inside = [p for p in c.points if bbox.contains(p["lon"], p["lat"])]
        if inside:
            groups["in_view"].append(c)
            view_points[c.id] = inside
        elif remote and c.points:
            groups["remote_elsewhere"].append(c)
        elif not c.points and (remote or within(c.location_region_id, region_id, parents)):
            groups["location_unverified"].append(c)
    for g in groups.values():
        g.sort(key=lambda c: c.sort_key)
    return groups, view_points


def build_map(
    groups: dict[str, list[Candidate]],
    view_points: dict[str, list[dict]],
    workplace_by_id: dict[str, str],
    zoom: float | None,
    max_points: int,
) -> tuple[dict, dict]:
    features = []
    for c in groups["in_view"]:
        for p in view_points[c.id]:
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
                    "properties": {
                        "job_id": c.id,
                        "location_id": p["location_id"],
                        "location_role": p["role"],
                        "workplace_type": workplace_by_id[c.id],
                        # company's single city office, not a job-stated address
                        "inferred": bool(p.get("inferred", False)),
                    },
                }
            )
    unique_jobs = len(groups["in_view"])
    if len(features) <= max_points:
        return {"type": "FeatureCollection", "features": features}, {
            "complete": True,
            "mode": "points",
            "unique_job_count": unique_jobs,
            "marker_count": len(features),
        }
    # Aggregate the full set into grid cells; counts are exact, positions are cell centroids.
    cell = 360.0 / (2 ** max(min(zoom or 9, 18), 0)) / 8
    cells: dict[tuple[int, int], dict[str, Any]] = {}
    for f in features:
        lon, lat = f["geometry"]["coordinates"]
        key = (math.floor(lon / cell), math.floor(lat / cell))
        agg = cells.setdefault(key, {"n": 0, "lon": 0.0, "lat": 0.0, "jobs": set()})
        agg["n"] += 1
        agg["lon"] += lon
        agg["lat"] += lat
        agg["jobs"].add(f["properties"]["job_id"])
    clusters = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [a["lon"] / a["n"], a["lat"] / a["n"]]},
            "properties": {"cluster": True, "point_count": a["n"], "job_count": len(a["jobs"])},
        }
        for a in cells.values()
    ]
    return {"type": "FeatureCollection", "features": clusters}, {
        "complete": True,
        "mode": "clusters",
        "unique_job_count": unique_jobs,
        "marker_count": len(features),
    }


# ---------------------------------------------------------------- SQL


def date_floor(window_start: datetime | None) -> date | None:
    """Earliest calendar date (zone unknown, UTC-12..UTC+14) that certainly began after
    window_start: date d starts no earlier than (d-1)T10:00Z, so require that >= start."""
    if window_start is None:
        return None
    shifted = window_start.astimezone(UTC) + timedelta(hours=14)
    d = shifted.date()
    if shifted.time() != dtime(0, 0):
        d += timedelta(days=1)
    return d


def _time_bounds(window: str, as_of: datetime) -> tuple[datetime | None, Any]:
    if window == "all":
        return None, None
    if window == "today":
        local = as_of.astimezone(TORONTO)
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
        return midnight, local.date()
    return as_of - WINDOWS[window], None


BASE_SQL = """
SELECT j.id, j.workplace_type, j.location_region_id, j.eligibility_status,
       j.posted_at, j.first_seen_at,
       CASE
         WHEN CAST(:window_start AS timestamptz) IS NULL THEN true
         WHEN j.posted_basis = 'original' AND j.posted_precision = 'datetime'
              AND j.posted_at >= CAST(:window_start AS timestamptz)
              AND j.posted_at <= :as_of THEN true
         WHEN CAST(:today_date AS date) IS NOT NULL AND j.posted_basis = 'original'
              AND j.posted_precision = 'date' AND j.posted_tz_basis = 'America/Toronto'
              AND j.posted_date = CAST(:today_date AS date) THEN true
         WHEN CAST(:date_floor AS date) IS NOT NULL AND j.posted_basis = 'original'
              AND j.posted_precision = 'date'
              AND j.posted_date >= CAST(:date_floor AS date) THEN true
         -- No original posting time, but the posting was absent from a complete listing
         -- fetched at listed_after: it first appeared inside the window.
         WHEN j.posted_basis <> 'original' AND j.listed_after IS NOT NULL
              AND j.listed_after >= CAST(:window_start AS timestamptz) THEN true
         ELSE false
       END AS in_window,
       (j.posted_basis = 'original' AND j.posted_precision = 'datetime') AS trusted_time
FROM jobs j
WHERE j.status = 'active' AND j.is_publishable
  AND j.last_verified_at >= :fresh_cutoff
  AND j.first_seen_at <= :as_of
  AND (CAST(:workplace AS text) = 'all' OR j.workplace_type = CAST(:workplace AS text))
  AND (CAST(:tsq AS text) IS NULL OR j.title_tsv @@ to_tsquery('simple', CAST(:tsq AS text))
       OR word_similarity(:q, coalesce(j.title, '')) >= 0.6)
"""

USABLE_ROLES_SQL = (
    "CASE WHEN c.workplace_type = 'remote' THEN ARRAY['company_office', 'headquarters'] "
    "ELSE ARRAY['work_site'] END"
)

# Same rules as group_candidates, evaluated in the database.
#   :chain    target region and its ancestors        (eligibility excludes / includes)
#   :covering chain + regions inside the target      (eligibility includes)
#   :inside   regions inside the target (DB tree)    (label region of jobs without a point)

# Composed from module constants only; every value is a bound parameter. Each candidate's
# few usable points are aggregated once (LATERAL, by primary key) into has_point / in_view, so
# the viewport test runs on that job's points only.
GROUP_SQL = f"""
WITH cand AS MATERIALIZED (SELECT * FROM ({BASE_SQL}) base WHERE in_window),
flags AS (
  SELECT c.id, c.workplace_type, c.posted_at, c.first_seen_at, c.location_region_id,
    (c.workplace_type <> 'remote' OR (
       NOT EXISTS (SELECT 1 FROM job_eligibility_regions x WHERE x.job_id = c.id
                   AND x.include_or_exclude = 'exclude' AND x.region_id = ANY(:chain))
       AND EXISTS (SELECT 1 FROM job_eligibility_regions x WHERE x.job_id = c.id
                   AND x.include_or_exclude = 'include' AND x.region_id = ANY(:covering))
    )) AS eligible,
    pt.n > 0 AS has_point,
    coalesce(pt.in_view, false) AS in_view
  FROM cand c
  CROSS JOIN LATERAL (
    SELECT count(*) AS n,
           bool_or(ST_X(l.point) BETWEEN :w AND :e AND ST_Y(l.point) BETWEEN :s AND :n)
             AS in_view
    FROM job_locations jl JOIN locations l ON l.id = jl.location_id
    WHERE jl.job_id = c.id AND jl.verification_status = 'verified'
      AND l.point IS NOT NULL AND l.precision IN ('rooftop', 'street')
      AND jl.role = ANY({USABLE_ROLES_SQL})
  ) pt
),
graded AS (
  SELECT id, posted_at, first_seen_at, workplace_type,
    CASE
      WHEN NOT eligible THEN NULL
      WHEN in_view THEN 'in_view'
      WHEN workplace_type = 'remote' AND has_point THEN 'remote_elsewhere'
      WHEN NOT has_point AND (workplace_type = 'remote' OR location_region_id = ANY(:inside))
        THEN 'location_unverified'
    END AS grp
  FROM flags
)
SELECT id::text AS id, workplace_type, grp FROM graded WHERE grp IS NOT NULL
ORDER BY grp, posted_at DESC NULLS LAST, first_seen_at DESC, id::text COLLATE "C"
"""  # noqa: S608

UNTRUSTED_SQL = f"""
WITH base AS ({BASE_SQL})
SELECT count(*) FROM base WHERE NOT in_window AND NOT trusted_time
"""  # noqa: S608

# Usable points (role by workplace) of the given jobs, driven from the id list (hash join);
# the viewport is a plain coordinate test on those points, never a spatial-index probe.
VIEW_POINTS_SQL = """
SELECT jl.job_id::text AS job_id, l.id::text AS location_id, jl.role,
       ST_X(l.point) AS lon, ST_Y(l.point) AS lat,
       coalesce(e.method = 'company_single_city_office', false) AS inferred
FROM unnest(CAST(:ids AS uuid[])) AS ids(id)
JOIN jobs j ON j.id = ids.id
JOIN job_locations jl ON jl.job_id = ids.id
JOIN locations l ON l.id = jl.location_id
LEFT JOIN evidence e ON e.id = jl.evidence_id
WHERE jl.verification_status = 'verified'
  AND l.point IS NOT NULL AND l.precision IN ('rooftop', 'street')
  AND jl.role = ANY(CASE WHEN j.workplace_type = 'remote'
                         THEN ARRAY['company_office', 'headquarters'] ELSE ARRAY['work_site'] END)
  AND (CAST(:w AS float8) IS NULL
       OR (ST_X(l.point) BETWEEN CAST(:w AS float8) AND CAST(:e AS float8)
           AND ST_Y(l.point) BETWEEN CAST(:s AS float8) AND CAST(:n AS float8)))
"""


async def region_info(session: AsyncSession) -> dict[str, dict]:
    rows = await session.execute(
        text(
            "SELECT id, name, parent_id, kind, geometry_is_approximate, "
            "ST_XMin(bbox) w, ST_YMin(bbox) s, ST_XMax(bbox) e, ST_YMax(bbox) n FROM regions"
        )
    )
    return {r.id: dict(r._mapping) for r in rows}


def region_params(regions: dict[str, dict], region_id: str) -> dict[str, list[str]]:
    """Region sets for GROUP_SQL, mirroring `covers` (static region tree) and `within`
    (regions table) as used by group_candidates."""
    parents = {rid: info["parent_id"] for rid, info in regions.items()}
    known = set(regions) | set(PARENT)
    chain = sorted(r for r in known if is_within(region_id, r))
    return {
        "chain": chain,
        "covering": sorted(set(chain) | {r for r in known if is_within(r, region_id)}),
        "inside": sorted(r for r in regions if within(r, region_id, parents)),
    }


async def run_search(session: AsyncSession, redis: Redis, p: SearchParams) -> dict:
    s = get_settings()
    if p.q is not None and len(p.q) > MAX_Q:
        raise SearchError("QUERY_TOO_LONG", f"q must be at most {MAX_Q} characters", 422)
    # One consistent snapshot for counts, groups and map.
    await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    regions = await region_info(session)
    if p.region_id not in regions:
        raise SearchError("UNKNOWN_REGION", f"unknown region_id {p.region_id!r}", 422)
    region = regions[p.region_id]
    bbox = p.bbox
    warnings: list[dict] = []
    if bbox is None:
        if region["w"] is None:
            raise SearchError("BBOX_REQUIRED", "bbox required for this region", 422)
        bbox = BBox(region["w"], region["s"], region["e"], region["n"])
    if region["geometry_is_approximate"]:
        warnings.append(
            {
                "code": "APPROXIMATE_REGION",
                "message": f"{region['name']} uses an approximate boundary",
            }
        )

    as_of = utcnow()
    window_start, today_date = _time_bounds(p.time_window, as_of)
    q = (p.q or "").strip() or None
    tsq = build_tsquery(q) if q else None
    if q and tsq is None:
        tsq = "zzzznomatch"
    params = {
        "window_start": window_start,
        "today_date": today_date,
        # Rolling windows only; "today" with date-only data needs a known Toronto zone.
        "date_floor": date_floor(window_start) if p.time_window != "today" else None,
        "as_of": as_of,
        "fresh_cutoff": as_of - timedelta(hours=s.freshness_hours),
        "workplace": p.workplace,
        "tsq": tsq,
        "q": q or "",
    }
    grouped = (
        await session.execute(
            text(GROUP_SQL),
            {
                **params,
                "w": bbox.west, "s": bbox.south, "e": bbox.east, "n": bbox.north,
                **region_params(regions, p.region_id),
            },
        )
    ).all()  # fmt: skip
    excluded_untrusted = 0
    if p.time_window != "all":
        excluded_untrusted = (await session.execute(text(UNTRUSTED_SQL), params)).scalar_one()

    groups: dict[str, list[Candidate]] = {g: [] for g in GROUPS}
    workplace_by_id: dict[str, str] = {}
    for r in grouped:  # already in final order
        groups[r.grp].append(Candidate(r.id, r.workplace_type, None, "", ()))
        workplace_by_id[r.id] = r.workplace_type
    # Coordinates for the map: usable points of in-view jobs, inside the bbox only.
    view_points = await marker_points(session, [c.id for c in groups["in_view"]], bbox)
    fmap, map_meta = build_map(
        groups, view_points, workplace_by_id, p.zoom, s.search_max_map_points
    )
    if map_meta["mode"] == "clusters":
        warnings.append(
            {"code": "MAP_AGGREGATED", "message": "Too many points; zoom in to see individual jobs"}
        )
    if p.time_window != "all" and excluded_untrusted:
        warnings.append(
            {
                "code": "UNTRUSTED_POSTING_TIME_EXCLUDED",
                "message": f"{excluded_untrusted} matching jobs have no original posting time "
                "precise enough for this filter and are excluded",
                "count": excluded_untrusted,
            }
        )

    search_id = secrets.token_urlsafe(12)
    ttl = s.search_snapshot_ttl_seconds
    snapshot = {
        "as_of": as_of.isoformat(),
        "filters": _filters(p, bbox),
        # Ordered ids only; card markers are read per page (see project).
        "groups": {g: pack_ids([c.id for c in groups[g]]) for g in GROUPS},
    }
    await redis.set(f"search:{search_id}", json.dumps(snapshot), ex=ttl)
    out_groups = {}
    for g in GROUPS:
        page_ids = [c.id for c in groups[g][: p.limit]]
        items = await project(session, page_ids, g, bbox, view_points)
        if items is None:  # a job changed between grouping and projection; extremely rare
            raise SearchError("SEARCH_EXPIRED", "results changed; retry", 410)
        nxt = len(groups[g]) > p.limit
        out_groups[g] = {
            "items": items,
            "next_cursor": encode_cursor(search_id, g, p.limit) if nxt else None,
        }
    return {
        "search_id": search_id,
        "as_of": as_of.isoformat(),
        "expires_at": (as_of + timedelta(seconds=ttl)).isoformat(),
        "filters": snapshot["filters"],
        "counts": {
            "total": sum(len(groups[g]) for g in GROUPS),
            **{g: len(groups[g]) for g in GROUPS},
        },
        "groups": out_groups,
        "map": fmap,
        "map_meta": map_meta,
        "warnings": warnings,
    }


def _filters(p: SearchParams, bbox: BBox) -> dict:
    return {
        "q": p.q,
        "region_id": p.region_id,
        "bbox": [bbox.west, bbox.south, bbox.east, bbox.north],
        "time_window": p.time_window,
        "workplace": p.workplace,
    }


def encode_cursor(search_id: str, group: str, offset: int) -> str:
    raw = json.dumps({"s": search_id, "g": group, "o": offset}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[str, str, int]:
    try:
        pad = "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(cursor + pad))
        return str(data["s"]), str(data["g"]), int(data["o"])
    except (ValueError, KeyError, TypeError) as exc:
        raise SearchError("INVALID_CURSOR", "cursor is malformed", 422) from exc


def pack_ids(ids: list[str]) -> str:
    """Ordered job ids as base64 of their 16-byte UUIDs (~22 bytes each vs ~40 as JSON)."""
    return base64.b64encode(b"".join(uuid.UUID(i).bytes for i in ids)).decode()


def unpack_ids(packed: str | list[str]) -> list[str]:
    if isinstance(packed, list):  # snapshot written before packing (expires within the TTL)
        return packed
    raw = base64.b64decode(packed)
    return [str(uuid.UUID(bytes=raw[i : i + 16])) for i in range(0, len(raw), 16)]


PROJECT_SQL = """
SELECT j.id::text AS id, j.title, c.name AS company, j.workplace_type, j.status,
       j.is_publishable, j.last_verified_at, j.posted_at, j.posted_date, j.posted_precision,
       j.posted_basis, j.first_seen_at, j.listed_after, j.location_text, j.location_status,
       j.remote_eligibility_text, j.employment_type, j.apply_url,
       j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.salary_raw
FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
WHERE j.id = ANY(CAST(:ids AS uuid[]))
"""


async def marker_points(
    session: AsyncSession, ids: list[str], bbox: BBox | None
) -> dict[str, list[dict]]:
    """Usable points per job (role by workplace); limited to `bbox` when given."""
    out: dict[str, list[dict]] = defaultdict(list)
    if not ids:
        return out
    box = (
        {"w": bbox.west, "s": bbox.south, "e": bbox.east, "n": bbox.north}
        if bbox
        else {"w": None, "s": None, "e": None, "n": None}
    )
    for pr in await session.execute(text(VIEW_POINTS_SQL), {"ids": ids, **box}):
        out[pr.job_id].append(dict(pr._mapping))
    return out


async def project(
    session: AsyncSession,
    ids: list[str],
    group: str,
    bbox: BBox,
    known_points: dict[str, list[dict]] | None = None,
) -> list[dict] | None:
    """List-card projection in snapshot order. None if any job is no longer open/fresh.
    Card markers: in-view jobs show their points inside the searched bbox; remote jobs whose
    company is elsewhere show the company point(s)."""
    if not ids:
        return []
    s = get_settings()
    rows = {r.id: r for r in await session.execute(text(PROJECT_SQL), {"ids": ids})}
    if group == "location_unverified":
        points: dict[str, list[dict]] = {}
    elif known_points is not None and group == "in_view":
        points = known_points
    else:
        points = await marker_points(session, ids, bbox if group == "in_view" else None)
    cutoff = utcnow() - timedelta(hours=s.freshness_hours)
    loc_ids = {p["location_id"] for i in ids for p in points.get(i, [])}
    labels = {}
    if loc_ids:
        res = await session.execute(
            text(
                "SELECT id::text AS id, display_address FROM locations "
                "WHERE id = ANY(CAST(:ids AS uuid[]))"
            ),
            {"ids": list(loc_ids)},
        )
        labels = {r.id: r.display_address for r in res}
    items = []
    for i in ids:
        r = rows.get(i)
        if (
            r is None
            or r.status != "active"
            or not r.is_publishable
            or r.last_verified_at is None
            or r.last_verified_at < cutoff
        ):
            return None
        pts = points.get(i, [])
        items.append(
            {
                "id": r.id,
                "title": r.title,
                "company": r.company,
                "workplace_type": r.workplace_type,
                "location_status": r.location_status,
                "location_label": r.location_text,
                "markers": [
                    {
                        "lon": p["lon"],
                        "lat": p["lat"],
                        "role": p["role"],
                        "address": labels.get(p["location_id"]),
                    }
                    for p in pts
                ],
                "remote_eligibility_text": r.remote_eligibility_text,
                "posted_at": r.posted_at.isoformat() if r.posted_at else None,
                "posted_date": r.posted_date.isoformat() if r.posted_date else None,
                "posted_precision": r.posted_precision,
                "posted_basis": r.posted_basis,
                "first_seen_at": r.first_seen_at.isoformat(),
                "listed_after": r.listed_after.isoformat() if r.listed_after else None,
                "last_verified_at": r.last_verified_at.isoformat(),
                "employment_type": r.employment_type,
                "salary": _salary(r),
                "apply_url": r.apply_url,
            }
        )
    return items


def _salary(r) -> dict | None:
    if r.salary_min is None and r.salary_max is None and not r.salary_raw:
        return None
    return {
        "min": float(r.salary_min) if r.salary_min is not None else None,
        "max": float(r.salary_max) if r.salary_max is not None else None,
        "currency": r.salary_currency,
        "period": r.salary_period,
        "raw_text": r.salary_raw,
    }


async def page(
    session: AsyncSession, redis: Redis, search_id: str, cursor: str, limit: int
) -> dict:
    sid, group, offset = decode_cursor(cursor)
    if sid != search_id or group not in GROUPS:
        raise SearchError("INVALID_CURSOR", "cursor does not belong to this search", 422)
    raw = await redis.get(f"search:{search_id}")
    if raw is None:
        raise SearchError("SEARCH_EXPIRED", "search snapshot expired; run the search again", 410)
    snap = json.loads(raw)
    ids = unpack_ids(snap["groups"][group])
    page_ids = ids[offset : offset + limit]
    items = await project(session, page_ids, group, BBox(*snap["filters"]["bbox"]))
    if items is None:
        await redis.delete(f"search:{search_id}")
        raise SearchError("SEARCH_EXPIRED", "a result is no longer open; run the search again", 410)
    nxt = offset + limit < len(ids)
    return {
        "search_id": search_id,
        "group": group,
        "as_of": snap["as_of"],
        "items": items,
        "next_cursor": encode_cursor(search_id, group, offset + limit) if nxt else None,
    }
