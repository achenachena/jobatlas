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

The ordered ids per group are stored in Redis for SEARCH_SNAPSHOT_TTL_SECONDS; pages are read
from the snapshot so map and list never disagree. A page containing a job that is no longer
open invalidates the snapshot (410 SEARCH_EXPIRED) instead of showing it as current.
"""

from __future__ import annotations

import base64
import json
import math
import re
import secrets
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
from app.services.region_match import covers

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
SELECT j.id::text AS id, j.workplace_type, j.location_region_id, j.eligibility_status,
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

POINTS_SQL = """
SELECT jl.job_id::text AS job_id, l.id::text AS location_id, jl.role,
       ST_X(l.point) AS lon, ST_Y(l.point) AS lat
FROM job_locations jl JOIN locations l ON l.id = jl.location_id
WHERE jl.job_id = ANY(CAST(:ids AS uuid[])) AND jl.verification_status = 'verified'
  AND l.point IS NOT NULL AND l.precision IN ('rooftop', 'street')
"""

ELIG_SQL = """
SELECT job_id::text AS job_id, region_id, include_or_exclude
FROM job_eligibility_regions WHERE job_id = ANY(CAST(:ids AS uuid[]))
"""


async def region_info(session: AsyncSession) -> dict[str, dict]:
    rows = await session.execute(
        text(
            "SELECT id, name, parent_id, kind, geometry_is_approximate, "
            "ST_XMin(bbox) w, ST_YMin(bbox) s, ST_XMax(bbox) e, ST_YMax(bbox) n FROM regions"
        )
    )
    return {r.id: dict(r._mapping) for r in rows}


def _sort_key(row) -> tuple:
    posted = row.posted_at.timestamp() if row.posted_at else float("-inf")
    return (-posted, -row.first_seen_at.timestamp(), row.id)


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
    rows = (
        await session.execute(
            text(BASE_SQL),
            {
                "window_start": window_start,
                "today_date": today_date,
                # Rolling windows only; "today" with date-only data needs a known Toronto zone.
                "date_floor": date_floor(window_start) if p.time_window != "today" else None,
                "as_of": as_of,
                "fresh_cutoff": as_of - timedelta(hours=s.freshness_hours),
                "workplace": p.workplace,
                "tsq": tsq,
                "q": q or "",
            },
        )
    ).all()
    excluded_untrusted = sum(1 for r in rows if not r.in_window and not r.trusted_time)
    rows = [r for r in rows if r.in_window]
    ids = [r.id for r in rows]
    points: dict[str, list[dict]] = defaultdict(list)
    includes: dict[str, set[str]] = defaultdict(set)
    excludes: dict[str, set[str]] = defaultdict(set)
    if ids:
        for pr in await session.execute(text(POINTS_SQL), {"ids": ids}):
            points[pr.job_id].append(dict(pr._mapping))
        for er in await session.execute(text(ELIG_SQL), {"ids": ids}):
            (includes if er.include_or_exclude == "include" else excludes)[er.job_id].add(
                er.region_id
            )
    cands = []
    for r in rows:
        usable_roles = (
            {"company_office", "headquarters"} if r.workplace_type == "remote" else {"work_site"}
        )
        cands.append(
            Candidate(
                id=r.id,
                workplace_type=r.workplace_type,
                location_region_id=r.location_region_id,
                eligibility_status=r.eligibility_status,
                sort_key=_sort_key(r),
                points=[pt for pt in points[r.id] if pt["role"] in usable_roles],
                includes=includes[r.id],
                excludes=excludes[r.id],
            )
        )
    parents = {rid: info["parent_id"] for rid, info in regions.items()}
    groups, view_points = group_candidates(cands, p.region_id, bbox, parents)
    workplace_by_id = {c.id: c.workplace_type for c in cands}
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
        "groups": {g: [c.id for c in groups[g]] for g in GROUPS},
        "points": {c.id: view_points.get(c.id, c.points) for g in GROUPS for c in groups[g]},
    }
    await redis.set(f"search:{search_id}", json.dumps(snapshot), ex=ttl)
    out_groups = {}
    for g in GROUPS:
        page_ids = snapshot["groups"][g][: p.limit]
        items = await project(session, page_ids, snapshot["points"], as_of)
        if items is None:  # a job changed between grouping and projection; extremely rare
            raise SearchError("SEARCH_EXPIRED", "results changed; retry", 410)
        nxt = len(snapshot["groups"][g]) > p.limit
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


PROJECT_SQL = """
SELECT j.id::text AS id, j.title, c.name AS company, j.workplace_type, j.status,
       j.is_publishable, j.last_verified_at, j.posted_at, j.posted_date, j.posted_precision,
       j.posted_basis, j.first_seen_at, j.location_text, j.location_status,
       j.remote_eligibility_text, j.employment_type, j.apply_url,
       j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.salary_raw
FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
WHERE j.id = ANY(CAST(:ids AS uuid[]))
"""


async def project(
    session: AsyncSession, ids: list[str], points: dict[str, list[dict]], as_of: datetime
) -> list[dict] | None:
    """List-card projection in snapshot order. None if any job is no longer open/fresh."""
    if not ids:
        return []
    s = get_settings()
    rows = {r.id: r for r in await session.execute(text(PROJECT_SQL), {"ids": ids})}
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
    ids = snap["groups"][group]
    page_ids = ids[offset : offset + limit]
    items = await project(session, page_ids, snap["points"], datetime.fromisoformat(snap["as_of"]))
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
