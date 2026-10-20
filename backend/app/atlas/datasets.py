"""The datasets the v2 API can serve, behind one interface.

- RealDataset: the published release of admitted sources, for one dataset id: Job Bank open
  data ("jobbank") or Employer boards ("ats"). The two are never added together.
- DemoDataset: deterministic, generated on request, never stored with real records, always
  labelled data_mode="demo". It exists to show long history, dense cities, gaps and partial
  days. A failed real request never falls back to it.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.atlas.metrics import (
    REAL_DATASET,
    Frame,
    backfilled_span,
    current_release,
    frames,
    release_by_id,
    release_cities,
    rolling_frames,
)
from app.atlas.models import AtlasCity, AtlasDailyMetric, AtlasRelease
from app.atlas.occupations import CLASSIFICATION_VERSION, OCCUPATIONS
from app.atlas.permissions import admitted, source
from app.atlas.windows import REPORTING_TZ, WINDOWS
from app.core.timeutil import utcnow


@dataclass(frozen=True)
class Info:
    dataset_id: str
    data_mode: str  # real | demo
    release_id: str
    history_start: date
    data_through: date
    cutoff: datetime | None  # set when data_through is still in progress
    source_set_id: str
    classification_version: str
    published_at: datetime | None
    gaps: list[dict]
    quality: dict
    stale: bool
    change_kind: str
    backfilled: tuple[date, date] | None = None  # days whose counts are lower bounds


def city_payload(c: AtlasCity) -> dict:
    return {
        "city_id": c.id, "name": c.name, "province": c.province, "country": c.country,
        "lat": round(c.lat, 4), "lon": round(c.lon, 4), "population": c.population,
        "aliases": [], "kind": c.kind, "evidence": c.evidence,
    }  # fmt: skip


ATS_DATASET = "ats"
# Days after which a dataset's latest day counts as overdue: Job Bank publishes monthly,
# Employer boards are swept hourly.
STALE_AFTER = {REAL_DATASET: 46, ATS_DATASET: 2}


class RealDataset:
    data_mode = "real"

    def __init__(self, session: Session, release: AtlasRelease):
        self.session = session
        self.release = release
        self.dataset_id = release.dataset_id

    @classmethod
    def open(
        cls, session: Session, dataset_id: str = REAL_DATASET, release_id: str | None = None
    ) -> RealDataset | None:
        r = (
            release_by_id(session, dataset_id, release_id)
            if release_id
            else current_release(session, dataset_id)
        )
        if r is None:
            return None
        for key in r.source_set_id.split("+"):
            ok, _ = admitted(source(session, key))
            if not ok:
                return None  # permission lapsed: the release must not be served
        return cls(session, r)

    @property
    def data_through(self) -> date:
        """Last served day. An Employer boards release ends on the day it was swept, which was
        not over yet: it serves through the day before (the last complete day)."""
        lag = 1 if self.dataset_id == ATS_DATASET else 0
        return self.release.data_through - timedelta(days=lag)

    def info(self) -> Info:
        r = self.release
        through = self.data_through
        stale = (datetime.now(REPORTING_TZ).date() - through).days > STALE_AFTER[self.dataset_id]
        gaps = (r.coverage or {}).get("gaps", [])
        return Info(
            self.dataset_id, self.data_mode, r.id, r.history_start, through, None,
            r.source_set_id, r.classification_version, r.published_at, gaps, r.quality or {},
            stale, r.change_kind, backfilled_span(r),
        )  # fmt: skip

    def occupation_totals(self, days: int) -> dict[str, int]:
        """Postings per occupation, nationally, in the last `days` served days."""
        last = self.data_through
        q = (
            select(AtlasDailyMetric.occupation_id, func.sum(AtlasDailyMetric.count))
            .where(
                AtlasDailyMetric.release_id == self.release.id,
                AtlasDailyMetric.scope == "national",
                AtlasDailyMetric.day.between(last - timedelta(days=days - 1), last),
            )
            .group_by(AtlasDailyMetric.occupation_id)
        )
        return {occ: int(n) for occ, n in self.session.execute(q)}

    def cities(self) -> list[dict]:
        return [city_payload(c) for c in release_cities(self.session, self.release)]

    def city_ids(self) -> list[str]:
        return [c.id for c in release_cities(self.session, self.release)]

    def frames(
        self, occupation: str, window_key: str, first: date, last: date, city_ids: list[str]
    ) -> list[Frame]:
        return frames(self.session, self.release, occupation, window_key, first, last, city_ids)

    def city_frames(
        self, occupation: str, window_key: str, first: date, last: date, city_id: str
    ) -> list[Frame]:
        """One city's frames, reading only its rows (no national totals)."""
        return frames(self.session, self.release, occupation, window_key, first, last,
                      [city_id], only_city=True)  # fmt: skip


# ---------------------------------------------------------------- demo

DEMO_HISTORY_START = date(2023, 1, 1)
DEMO_GAP = (date(2024, 7, 8), date(2024, 7, 14))  # shows how a coverage gap is rendered
DEMO_CITY_COUNT = 200
OCC_SHARE = {"software_development": 0.012, "human_resources": 0.008, "bartender": 0.006,
             "barista": 0.004, "registered_nurse": 0.03, "cook": 0.05}  # fmt: skip


def _noise(*parts: object) -> float:
    h = hashlib.blake2b("|".join(map(str, parts)).encode(), digest_size=8).digest()
    return int.from_bytes(h, "big") / 2**64


class DemoDataset:
    dataset_id = "demo-v1"
    data_mode = "demo"

    def __init__(self, session: Session):
        self.session = session
        self._cities = list(
            session.scalars(
                select(AtlasCity).order_by(AtlasCity.population.desc()).limit(DEMO_CITY_COUNT)
            )
        )
        self.not_covered = {c.id for c in self._cities if c.province in ("NU", "NT", "YT")}

    @property
    def available(self) -> bool:
        return bool(self._cities)

    def info(self) -> Info:
        now = datetime.now(REPORTING_TZ)
        today = now.date()
        return Info(self.dataset_id, self.data_mode, f"demo-v1-{today.isoformat()}",
                    DEMO_HISTORY_START, today, now, "demo-generator-v1",
                    CLASSIFICATION_VERSION, None,
                    [{"start": DEMO_GAP[0].isoformat(), "end": DEMO_GAP[1].isoformat(),
                      "reason": "demo: simulated outage"}], {}, False, "update")  # fmt: skip

    def cities(self) -> list[dict]:
        return [city_payload(c) for c in self._cities]

    def city_frames(
        self, occupation: str, window_key: str, first: date, last: date, city_id: str
    ) -> list[Frame]:
        return self.frames(occupation, window_key, first, last, [city_id])

    def frames(
        self, occupation: str, window_key: str, first: date, last: date, city_ids: list[str]
    ) -> list[Frame]:
        n = WINDOWS[window_key]
        info = self.info()
        pops = {c.id: c.population for c in self._cities}
        gaps: set[date] = set()
        g = DEMO_GAP[0]
        while g <= DEMO_GAP[1]:
            gaps.add(g)
            g += timedelta(days=1)
        daily: dict[date, dict[tuple[str, str], int]] = {}
        d = max(first - timedelta(days=n - 1), DEMO_HISTORY_START)
        while d <= last:
            if d not in gaps:
                row = {("city", c): _demo_count(c, pops.get(c, 0), occupation, d)
                       for c in city_ids if c not in self.not_covered}  # fmt: skip
                known = sum(row.values())
                row[("national", "")] = round(known * 1.08)
                row[("unconfirmed", "")] = round(known * 0.05)
                row[("remote", "")] = round(known * 0.03)
                daily[d] = row
            d += timedelta(days=1)
        return rolling_frames(first, last, window_key, DEMO_HISTORY_START, gaps, daily,
                              city_ids, not_covered=self.not_covered,
                              partial_on=info.data_through)  # fmt: skip


def _demo_count(city_id: str, population: int, occupation: str, day: date) -> int:
    if occupation == "all":
        base = 0.0016 * population**0.95
    else:
        base = 0.0016 * population**0.95 * OCC_SHARE.get(occupation, 0.01) * 6
    t = (day - DEMO_HISTORY_START).days
    season = 1 + 0.25 * math.sin(2 * math.pi * (t / 365.25 - 0.2))
    if occupation == "bartender":
        season += 0.35 * math.sin(2 * math.pi * (t / 365.25 - 0.35))  # summer patios
    trend = 1 + 0.15 * math.sin(t / 240 + _noise(city_id) * 6)
    weekday = 0.35 if day.weekday() >= 5 else 1.0
    lam = max(base * season * trend * weekday, 0.0)
    return int(lam + _noise(city_id, occupation, day) * (1 + math.sqrt(lam)))


def occupations_payload(keep: set[str] | None = None) -> list[dict]:
    """The "all" entry, then the occupations in `keep` (every occupation when None)."""
    return [
        {
            "id": "all",
            "label": "All jobs",
            "note": "every counted posting, including unclassified ones",
        }
    ] + [  # fmt: skip
        {"id": o.id, "label": o.label, "note": o.note}
        for o in OCCUPATIONS
        if keep is None or o.id in keep
    ]


def generated_at() -> datetime:
    return utcnow()
