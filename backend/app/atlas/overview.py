"""History overview: one prepared payload per (release, occupation, window) for the timed
replay. It replaces loading every city's daily history before a replay can start.

- Range: the first to the last *complete* window of the release (full length, not missing,
  not backfilled, with a national total), dates from the data, never invented.
- Frames: SAMPLES real dates spread evenly over the range, always both endpoints, plus, for
  every stretch of incomplete windows inside it, its first day (playback stops there) and the
  first complete day after it (where it may continue). Each frame is the exact window for its
  date, computed like every other atlas frame; the national total comes from national counts.
- City priority: each city's largest count over *every* day of the range, not just sampled
  days, so a city with a short burst keeps its place.
- Built once per key and stored gzipped. Every Job Bank release gets each occupation's 30-day
  overview before it is published (about a second each); any other key is built on first
  request under a transaction-scoped advisory lock, so concurrent first requests wait for one
  build instead of repeating it. Rows go with their release.
"""

from __future__ import annotations

import gzip
import json
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.atlas.metrics import METRIC, _days, backfilled_span, gap_days, rolling_frames
from app.atlas.models import AtlasDailyMetric, AtlasOverview
from app.atlas.occupations import PUBLIC_IDS
from app.atlas.windows import WINDOWS

FORMAT = 1  # bump when the payload changes: older stored payloads are then ignored
SAMPLES = 120
# Built with every Job Bank release before it is published: the replay's 30-day window.
PREPARED_WINDOW = "30d"


def _complete(f, n: int) -> bool:
    return (f.quality == "complete" and f.days_available == n and f.backfilled_days == 0
            and f.national is not None)  # fmt: skip


def _reason(f, n: int) -> str:
    if f.quality == "missing":
        return "not covered: unknown, not zero"
    if f.days_available < n or f.quality == "partial":
        return "partial window"
    if f.backfilled_days:
        return "backfilled: lower bounds"
    return "no national total"


def build(dataset, occupation: str, window_key: str) -> dict | None:
    """The overview of a RealDataset's release, or None without two complete windows."""
    session, release = dataset.session, dataset.release
    n = WINDOWS[window_key]
    through = dataset.data_through
    first = release.history_start + timedelta(days=n - 1)
    if first >= through:
        return None
    # Rows are read once, straight into per-day lists (no intermediate copy: memory stays low).
    rows = session.execute(
        select(AtlasDailyMetric.scope, AtlasDailyMetric.city_id, AtlasDailyMetric.day,
               AtlasDailyMetric.count)
        .where(AtlasDailyMetric.release_id == release.id, AtlasDailyMetric.metric == METRIC,
               AtlasDailyMetric.occupation_id == occupation,
               AtlasDailyMetric.day.between(release.history_start, through))
        .execution_options(yield_per=20_000)  # a server-side cursor, read in batches
    )  # fmt: skip
    other: dict[date, dict[tuple[str, str], int]] = defaultdict(dict)
    cities_on: dict[date, list[tuple[str, int]]] = defaultdict(list)
    for scope, city, day, count in rows:
        if scope == "city":
            cities_on[day].append((city, count))
        else:
            other[day][(scope, city)] = count
    # Quality, national total and notes per day, exactly as every other frame (no cities).
    days = rolling_frames(first, through, window_key, release.history_start, gap_days(release),
                          other, [], backfilled=_days(backfilled_span(release)))  # fmt: skip
    complete = [_complete(f, n) for f in days]
    if True not in complete:
        return None
    s = complete.index(True)
    e = len(complete) - 1 - complete[::-1].index(True)
    if e <= s:
        return None
    incomplete: list[list[int]] = []
    for i in range(s, e + 1):
        if complete[i]:
            continue
        if incomplete and incomplete[-1][1] == i - 1:
            incomplete[-1][1] = i
        else:
            incomplete.append([i, i])
    picks = {s + round(k * (e - s) / (SAMPLES - 1)) for k in range(SAMPLES)}
    for a, b in incomplete:
        picks.add(a)
        if b + 1 <= e:
            picks.add(b + 1)

    city_ids = sorted(dataset.city_ids())
    running: dict[str, int] = defaultdict(int)
    maxima: dict[str, int] = defaultdict(int)
    dirty: set[str] = set()  # cities whose count rose since the last day that counted
    snapshots: dict[int, list[int | None]] = {}
    d = release.history_start
    last = days[e].day
    while d <= last:
        for city, count in cities_on.get(d, ()):
            running[city] += count
            dirty.add(city)
        i = (d - first).days
        if i >= 0:
            f = days[i]
            if s <= i <= e and f.quality != "missing":
                for city in dirty:
                    maxima[city] = max(maxima[city], running[city])
                dirty.clear()
            if i in picks:
                snapshots[i] = (
                    [None] * len(city_ids) if f.quality == "missing"
                    else [running.get(c, 0) for c in city_ids]
                )  # fmt: skip
        for city, count in cities_on.get(d - timedelta(days=n - 1), ()):
            running[city] -= count
        d += timedelta(days=1)

    scale = (release.quality or {}).get("scale_max", {}).get(occupation, {}).get(window_key)
    return {
        "format": FORMAT, "dataset_id": dataset.dataset_id, "data_mode": dataset.data_mode,
        "release_id": release.id, "occupation": occupation, "window": window_key,
        "start": days[s].day.isoformat(), "end": days[e].day.isoformat(),
        "history_start": release.history_start.isoformat(), "data_through": through.isoformat(),
        "scale_max": scale, "samples": SAMPLES, "city_ids": city_ids,
        "city_max": [maxima.get(c, 0) for c in city_ids],
        "incomplete": [{"start": days[a].day.isoformat(), "end": days[b].day.isoformat(),
                        "reason": _reason(days[a], n)} for a, b in incomplete],
        "frames": [{"date": days[i].day.isoformat(), "quality": days[i].quality,
                    "days_available": days[i].days_available, "counts": snapshots[i],
                    "national": days[i].national, "notes": days[i].notes,
                    "backfilled_days": days[i].backfilled_days} for i in sorted(picks)],
    }  # fmt: skip


def encode(payload: dict) -> bytes:
    """Compressed once and served many times: the strongest level is worth it here. mtime=0
    keeps equal payloads byte-identical (and their ETag stable)."""
    return gzip.compress(json.dumps(payload, separators=(",", ":")).encode(), 9, mtime=0)


def get_or_build(dataset, occupation: str, window_key: str) -> bytes | None:
    """The stored gzipped payload, building it first if needed. Concurrent first requests for
    one key wait on an advisory lock held until the build commits, then read the stored row."""
    session: Session = dataset.session
    key = (dataset.release.id, occupation, window_key, FORMAT)
    row = session.get(AtlasOverview, key)
    if row is not None:
        return row.body
    session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
                    {"k": "overview|" + "|".join(map(str, key))})  # fmt: skip
    row = session.get(AtlasOverview, key)
    if row is None:
        payload = build(dataset, occupation, window_key)
        if payload is None:
            session.commit()
            return None
        row = AtlasOverview(release_id=key[0], occupation=occupation, window=window_key,
                            format=FORMAT, body=encode(payload))  # fmt: skip
        session.add(row)
    session.commit()  # releases the lock
    return row.body


def prepare(session: Session, release) -> int:
    """Build a Job Bank release's 30-day overview for every occupation (skipping stored ones).
    Returns how many were built."""
    from app.atlas.datasets import RealDataset

    have = set(session.scalars(select(AtlasOverview.occupation).where(
        AtlasOverview.release_id == release.id, AtlasOverview.window == PREPARED_WINDOW,
        AtlasOverview.format == FORMAT)))  # fmt: skip
    todo = [o for o in PUBLIC_IDS if o not in have]
    for occupation in todo:
        get_or_build(RealDataset(session, release), occupation, PREPARED_WINDOW)
    return len(todo)
