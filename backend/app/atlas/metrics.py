"""Daily base counts, atomic releases and window queries (spec §4, §5, §8, §10).

A release is built from admitted sources only, over periods whose coverage is `complete` or
`partial` (counted, but flagged in the release's coverage).
Its daily rows are inserted while the release is `building`; publishing flips one row, so a
client always reads one consistent version. Playback is bound to a release id; a release
stays readable for at least a day after it stops being current, so a client in history mode
is not moved.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from sqlalchemy import delete, select, text, update
from sqlalchemy.orm import Session

from app.atlas.models import (
    AtlasCity,
    AtlasCoverage,
    AtlasDailyMetric,
    AtlasGroup,
    AtlasRelease,
)
from app.atlas.occupations import CLASSIFICATION_VERSION
from app.atlas.permissions import admitted, source
from app.atlas.windows import WINDOWS, window
from app.core.timeutil import utcnow

METRIC = "new_postings"
KEEP_RELEASES = 3  # at least this many, plus every release current within KEEP_FOR
KEEP_FOR = timedelta(hours=24)
REAL_DATASET = "jobbank"
# Coverage note prefix of days rebuilt from postings still open when collection started
# (atlas/ats.py): their counts are lower bounds, closed postings are missing.
BACKFILL_NOTE = "backfilled"


class ReleaseError(Exception):
    pass


COUNTED = ("complete", "partial")


def _spans(days: list[date]) -> list[tuple[date, date]]:
    out: list[tuple[date, date]] = []
    for d in sorted(days):
        if out and d == out[-1][1] + timedelta(days=1):
            out[-1] = (out[-1][0], d)
        else:
            out.append((d, d))
    return out


def coverage_summary(session: Session, keys: list[str]) -> dict:
    """History bounds, uncovered spans (`gaps`) and `partial` spans over the union of the
    sources' counted periods. Periods may be months (Job Bank) or days (ATS). Partial days are
    counted but flagged: backfilled days and the day in progress."""
    rows = session.scalars(
        select(AtlasCoverage)
        .where(AtlasCoverage.source_key.in_(keys), AtlasCoverage.status.in_(COUNTED))
        .order_by(AtlasCoverage.period_start)
    ).all()
    if not rows:
        return {"history_start": None, "data_through": None, "gaps": [], "partial": [],
                "periods": 0}  # fmt: skip
    status: dict[date, str] = {}
    notes: dict[date, str] = {}
    for r in rows:
        d = r.period_start
        while d <= r.period_end:
            if status.get(d) != "complete":  # any source complete -> the day is complete
                status[d] = r.status
                notes[d] = r.note or ""
            d += timedelta(days=1)
    first, last = min(status), max(status)
    uncovered = [first + timedelta(days=i) for i in range((last - first).days + 1)
                 if first + timedelta(days=i) not in status]  # fmt: skip
    partial = [d for d, s in status.items() if s == "partial"]
    return {
        "history_start": first.isoformat(),
        "data_through": last.isoformat(),
        "gaps": [{"start": a.isoformat(), "end": b.isoformat(),
                  "reason": "period not imported or failed"} for a, b in _spans(uncovered)],
        "partial": [{"start": a.isoformat(), "end": b.isoformat(), "reason": notes[a]}
                    for a, b in _spans(partial)],
        "periods": len(rows),
    }  # fmt: skip


INSERT_SQL = """
INSERT INTO atlas_daily_metrics (release_id, metric, occupation_id, scope, city_id, day, count)
SELECT :rid, 'new_postings', occ, scope, city, day, count(*)
FROM (
  SELECT p.posted_on AS day, p.occupation_id, p.geo_status, coalesce(p.city_id, '') AS city_id
  FROM atlas_postings p
  JOIN atlas_coverage c ON c.source_key = p.source_key AND c.status IN ('complete', 'partial')
   AND p.posted_on BETWEEN c.period_start AND c.period_end
  WHERE p.source_key = ANY(:keys) AND p.posted_on IS NOT NULL
    AND (CAST(:full AS boolean) OR EXISTS (
      SELECT 1 FROM unnest(CAST(:starts AS date[]), CAST(:ends AS date[])) r(s, e)
      WHERE p.posted_on BETWEEN r.s AND r.e))
) p
CROSS JOIN LATERAL (VALUES (p.occupation_id), ('all')) o(occ)
CROSS JOIN LATERAL (
  VALUES ('national', ''),
         (p.geo_status, CASE WHEN p.geo_status = 'city' THEN p.city_id ELSE '' END)
) s(scope, city)
WHERE NOT (s.scope = 'city' AND s.city = '')
GROUP BY occ, scope, city, day
"""

# Incremental release: days outside the changed periods are copied from the previous release
# (only where coverage is still complete); the changed periods are recomputed.
COPY_SQL = """
INSERT INTO atlas_daily_metrics (release_id, metric, occupation_id, scope, city_id, day, count)
SELECT :rid, m.metric, m.occupation_id, m.scope, m.city_id, m.day, m.count
FROM atlas_daily_metrics m
WHERE m.release_id = :prev
  AND NOT EXISTS (SELECT 1 FROM unnest(CAST(:starts AS date[]), CAST(:ends AS date[])) r(s, e)
                  WHERE m.day BETWEEN r.s AND r.e)
  AND EXISTS (SELECT 1 FROM atlas_coverage c WHERE c.source_key = ANY(:keys)
              AND c.status IN ('complete', 'partial')
              AND m.day BETWEEN c.period_start AND c.period_end)
"""

QUALITY_SQL = """
SELECT count(*) AS records,
       count(*) FILTER (WHERE p.posted_on IS NULL) AS no_trusted_date,
       count(*) FILTER (WHERE p.geo_status = 'unconfirmed') AS city_unconfirmed,
       count(*) FILTER (WHERE p.geo_status = 'remote') AS remote_national,
       count(*) FILTER (WHERE p.occupation_id = 'unclassified') AS unclassified
FROM atlas_postings p WHERE p.source_key = ANY(:keys)
"""


def build_release(
    session: Session,
    dataset_id: str,
    keys: list[str],
    *,
    change_kind: str = "update",
    changed: list[tuple[date, date]] | None = None,
) -> AtlasRelease:
    """`changed`: periods whose records changed since the published release. When given (and
    the previous release used the same sources and classification), only those periods are
    recomputed and the rest is copied; otherwise everything is recomputed."""
    for key in keys:
        ok, why = admitted(source(session, key))
        if not ok:
            raise ReleaseError(f"{key}: {why}")
    cov = coverage_summary(session, keys)
    if cov["data_through"] is None:
        raise ReleaseError("no complete coverage period")
    now = utcnow()
    source_set = "+".join(sorted(keys))
    rid = f"{dataset_id}-{now:%Y%m%dT%H%M%S}-{uuid.uuid4().hex[:6]}"
    release = AtlasRelease(
        id=rid, dataset_id=dataset_id, status="building",
        data_through=date.fromisoformat(cov["data_through"]),
        history_start=date.fromisoformat(cov["history_start"]),
        source_set_id=source_set, classification_version=CLASSIFICATION_VERSION,
        coverage=cov, quality={}, change_kind=change_kind,
    )  # fmt: skip
    prev = current_release(session, dataset_id)
    incremental = (
        changed is not None
        and prev is not None
        and prev.source_set_id == source_set
        and prev.classification_version == CLASSIFICATION_VERSION
    )
    session.add(release)
    session.flush()
    starts = [a for a, _ in changed or []]
    ends = [b for _, b in changed or []]
    if incremental:
        session.execute(text(COPY_SQL), {"rid": rid, "prev": prev.id, "keys": keys,
                                         "starts": starts, "ends": ends})  # fmt: skip
    session.execute(text(INSERT_SQL), {"rid": rid, "keys": keys, "full": not incremental,
                                       "starts": starts, "ends": ends})  # fmt: skip
    q = session.execute(text(QUALITY_SQL), {"keys": keys}).mappings().one()
    release.quality = {
        **dict(q), "scale_max": scale_maxima(session, rid),
        "group_scale_max": {"grouping_version": grouping_version(session),
                            "values": scale_maxima(session, rid, GROUP_SCALE_SQL)},
        "build": "incremental" if incremental else "full",
        "recomputed": [f"{a}..{b}" for a, b in zip(starts, ends, strict=True)] if incremental
        else "all",
    }  # fmt: skip
    session.commit()
    return release


SCALE_SQL = """
SELECT occupation_id, max(total) FROM (
  SELECT occupation_id,
         sum(count) OVER (PARTITION BY occupation_id, city_id ORDER BY day
                          RANGE BETWEEN CAST(:span AS interval) PRECEDING AND CURRENT ROW) AS total
  FROM atlas_daily_metrics
  WHERE release_id = :rid AND metric = 'new_postings' AND scope = 'city'
) t GROUP BY occupation_id
"""


# The same over region totals: a group's members summed per day (a city without a group is its
# own region). Region totals are >= any member's count, so one scale serves both levels.
GROUP_SCALE_SQL = """
SELECT occupation_id, max(total) FROM (
  SELECT occupation_id,
         sum(n) OVER (PARTITION BY occupation_id, region ORDER BY day
                      RANGE BETWEEN CAST(:span AS interval) PRECEDING AND CURRENT ROW) AS total
  FROM (
    SELECT m.occupation_id, coalesce(g.group_id, m.city_id) AS region, m.day, sum(m.count) AS n
    FROM atlas_daily_metrics m LEFT JOIN atlas_city_groups g ON g.city_id = m.city_id
    WHERE m.release_id = :rid AND m.metric = 'new_postings' AND m.scope = 'city'
      AND (CAST(:occ AS text) IS NULL OR m.occupation_id = :occ)
    GROUP BY 1, 2, 3
  ) d
) t GROUP BY occupation_id
"""


def scale_maxima(
    session: Session, rid: str, sql: str = SCALE_SQL, occupation: str | None = None
) -> dict[str, dict[str, int]]:
    """Largest city (or region) count per occupation and window over the whole release: the
    fixed scale a playback uses (computed once, never per frame)."""
    out: dict[str, dict[str, int]] = {}
    for key, n in WINDOWS.items():
        params = {"rid": rid, "span": f"{n - 1} days", "occ": occupation}
        for occ, best in session.execute(text(sql), params):
            out.setdefault(occ, {})[key] = int(best or 0)
    return out


def grouping_version(session: Session) -> str | None:
    return session.scalar(select(AtlasGroup.version).limit(1))


def store_group_scales(session: Session) -> int:
    """Give every kept release the region scale of the current grouping (no rebuild: only the
    stored scale changes). Returns the number of releases updated."""
    v = grouping_version(session)
    releases = session.scalars(select(AtlasRelease).where(AtlasRelease.status != "building")).all()
    for r in releases:
        r.quality = {
            **(r.quality or {}),
            "group_scale_max": {
                "grouping_version": v,
                "values": scale_maxima(session, r.id, GROUP_SCALE_SQL),
            },
        }
        session.commit()  # one release at a time: an interrupted run keeps what it did
    return len(releases)


def publish(session: Session, release: AtlasRelease) -> None:
    """Atomic switch: the previous published release becomes superseded in the same commit."""
    session.execute(
        update(AtlasRelease)
        .where(AtlasRelease.dataset_id == release.dataset_id, AtlasRelease.status == "published")
        .values(status="superseded")
    )
    release.status = "published"
    release.published_at = utcnow()
    session.commit()
    old = expired_releases(
        session.execute(
            select(AtlasRelease.id, AtlasRelease.created_at, AtlasRelease.published_at)
            .where(AtlasRelease.dataset_id == release.dataset_id)
            .order_by(AtlasRelease.created_at.desc())
        ).all(),
        utcnow(),
    )
    if old:
        session.execute(delete(AtlasRelease).where(AtlasRelease.id.in_(old)))
        session.commit()


def expired_releases(rows: list, now: datetime) -> list[str]:
    """Releases (newest first: id, created_at, published_at) that may be deleted: a release is
    kept while it was current at some point within KEEP_FOR (a page bound to it then keeps
    working for that long), and the newest KEEP_RELEASES are always kept."""
    cutoff = now - KEEP_FOR
    # the newest release live before the cutoff was still current at the cutoff
    before = [(i, rid) for i, (rid, created, published) in enumerate(rows)
              if (published or created) < cutoff]  # fmt: skip
    return [rid for i, rid in before[1:] if i >= KEEP_RELEASES]


def current_release(session: Session, dataset_id: str) -> AtlasRelease | None:
    return session.scalar(
        select(AtlasRelease).where(
            AtlasRelease.dataset_id == dataset_id, AtlasRelease.status == "published"
        )
    )


def release_by_id(session: Session, dataset_id: str, rid: str) -> AtlasRelease | None:
    r = session.get(AtlasRelease, rid)
    return r if r is not None and r.dataset_id == dataset_id and r.status != "building" else None


# ---------------------------------------------------------------- queries


@dataclass
class Frame:
    day: date
    cities: dict[str, int | None]
    national: int | None
    unconfirmed: int | None
    remote: int | None
    quality: str  # complete | partial | missing
    days_available: int
    notes: list[str] = field(default_factory=list)
    backfilled_days: int = 0  # days of the window whose counts are lower bounds


def gap_days(release: AtlasRelease) -> set[date]:
    out: set[date] = set()
    for g in (release.coverage or {}).get("gaps", []):
        d, end = date.fromisoformat(g["start"]), date.fromisoformat(g["end"])
        while d <= end:
            out.add(d)
            d += timedelta(days=1)
    return out


def backfilled_span(release: AtlasRelease) -> tuple[date, date] | None:
    """Days of a release counted only from postings still open when collection started. The
    backfilled coverage ends the day before the first sweep; that day itself was observed only
    from the sweep on, so it is a lower bound too. Read from the release's frozen coverage."""
    spans = [(date.fromisoformat(p["start"]), date.fromisoformat(p["end"]))
             for p in (release.coverage or {}).get("partial", [])
             if p.get("reason", "").startswith(BACKFILL_NOTE)]  # fmt: skip
    if not spans:
        return None
    end = min(max(b for _, b in spans) + timedelta(days=1), release.data_through)
    return min(a for a, _ in spans), end


def _days(span: tuple[date, date] | None) -> set[date]:
    if span is None:
        return set()
    return {span[0] + timedelta(days=i) for i in range((span[1] - span[0]).days + 1)}


def release_cities(session: Session, release: AtlasRelease) -> list[AtlasCity]:
    ids = (
        select(AtlasDailyMetric.city_id)
        .where(
            AtlasDailyMetric.release_id == release.id,
            AtlasDailyMetric.scope == "city",
            AtlasDailyMetric.occupation_id == "all",
        )
        .distinct()
    )
    return list(session.scalars(select(AtlasCity).where(AtlasCity.id.in_(ids))))


def _daily(
    session: Session, release: AtlasRelease, occupation: str, first: date, last: date,
    city_id: str | None = None,
) -> dict[tuple[str, str, date], int]:  # fmt: skip
    q = select(
        AtlasDailyMetric.scope, AtlasDailyMetric.city_id, AtlasDailyMetric.day,
        AtlasDailyMetric.count,
    ).where(
        AtlasDailyMetric.release_id == release.id, AtlasDailyMetric.metric == METRIC,
        AtlasDailyMetric.occupation_id == occupation,
        AtlasDailyMetric.day.between(first, last),
    )  # fmt: skip
    if city_id is not None:
        q = q.where(AtlasDailyMetric.scope == "city", AtlasDailyMetric.city_id == city_id)
    return {(s, c, d): n for s, c, d, n in session.execute(q)}


def rolling_frames(
    first_day: date,
    last_day: date,
    window_key: str,
    history_start: date,
    gaps: set[date],
    daily: dict[date, dict[tuple[str, str], int]],
    city_ids: list[str],
    *,
    not_covered: set[str] = frozenset(),
    partial_on: date | None = None,
    backfilled: set[date] = frozenset(),
) -> list[Frame]:
    """One frame per day, each summing its own trailing window (playing a year never
    accumulates a year). Running totals make a full history O(days × cities). A window that
    touches a coverage gap is `missing` (counts null, never zero); a window starting before
    the history is `partial`."""
    n = WINDOWS[window_key]
    running: dict[tuple[str, str], int] = defaultdict(int)
    d = first_day - timedelta(days=n - 1)
    while d < first_day:
        for key, count in daily.get(d, {}).items():
            running[key] += count
        d += timedelta(days=1)
    out = []
    d = first_day
    while d <= last_day:
        for key, count in daily.get(d, {}).items():
            running[key] += count
        w = window(window_key, d, history_start=history_start)
        missing = sum(1 for i in range(n) if (d - timedelta(days=i)) in gaps)
        filled = sum(1 for i in range(n) if (d - timedelta(days=i)) in backfilled)
        notes = []
        if missing:
            quality = "missing"
            notes.append(f"{missing} day(s) of this window are not covered")
        elif w.days_available < n:
            quality = "partial"
            notes.append(f"only {w.days_available} of {n} days have data (history starts "
                         f"{history_start})")  # fmt: skip
        else:
            quality = "complete"
        if partial_on is not None and d == partial_on:
            notes.append("today is not over")
            if quality == "complete":
                quality = "partial"
        if filled:
            notes.append(f"{filled} day(s) of this window are backfilled from postings still "
                         "open when collection started: lower bounds")  # fmt: skip
        if quality == "missing":
            out.append(Frame(d, dict.fromkeys(city_ids), None, None, None, quality,
                             w.days_available, notes, filled))  # fmt: skip
        else:
            cities = {
                c: (None if c in not_covered else running.get(("city", c), 0)) for c in city_ids
            }
            out.append(Frame(
                d, cities, running.get(("national", ""), 0), running.get(("unconfirmed", ""), 0),
                running.get(("remote", ""), 0), quality, w.days_available, notes, filled,
            ))  # fmt: skip
        old = d - timedelta(days=n - 1)
        for key, count in daily.get(old, {}).items():
            running[key] -= count
        d += timedelta(days=1)
    return out


def frames(
    session: Session,
    release: AtlasRelease,
    occupation: str,
    window_key: str,
    first_day: date,
    last_day: date,
    city_ids: list[str],
) -> list[Frame]:
    n = WINDOWS[window_key]
    rows = _daily(session, release, occupation, first_day - timedelta(days=n - 1), last_day)
    daily: dict[date, dict[tuple[str, str], int]] = defaultdict(dict)
    for (scope, city, day), count in rows.items():
        daily[day][(scope, city)] = count
    return rolling_frames(first_day, last_day, window_key, release.history_start,
                          gap_days(release), daily, city_ids,
                          backfilled=_days(backfilled_span(release)))  # fmt: skip
