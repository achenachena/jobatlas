"""Reporting windows (spec §4.2). Reporting days are calendar days in America/Toronto; a
window of N days ending on day D covers D-(N-1) .. D. Bounds are half-open timestamps built
from local midnights, so a window crossing a DST change is 7 calendar days, not 168 hours.
Date-only source records belong to the day they state; no time of day is invented.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

REPORTING_TZ = ZoneInfo("America/Toronto")
WINDOWS = {"1d": 1, "7d": 7, "30d": 30}
DEFAULT_WINDOW = "7d"


def local_midnight(day: date) -> datetime:
    return datetime.combine(day, time(0), tzinfo=REPORTING_TZ)


@dataclass(frozen=True)
class Window:
    key: str
    first_day: date
    last_day: date
    start: datetime  # inclusive
    end: datetime  # exclusive
    partial_day: bool  # the last day is still in progress (data cut-off inside it)
    days_available: int  # days of the window covered by the dataset's history

    @property
    def complete(self) -> bool:
        return not self.partial_day and self.days_available == WINDOWS[self.key]


def window(
    key: str,
    last_day: date,
    *,
    history_start: date | None = None,
    cutoff: datetime | None = None,
) -> Window:
    """`cutoff` is the data's actual cut-off when `last_day` is the latest, unfinished day;
    then the window ends at the cut-off instead of the next midnight ("today is not over")."""
    n = WINDOWS[key]
    first = last_day - timedelta(days=n - 1)
    end = local_midnight(last_day + timedelta(days=1))
    partial = cutoff is not None and cutoff < end
    if partial:
        end = cutoff.astimezone(REPORTING_TZ)
    available = n
    if history_start is not None and history_start > first:
        available = max(0, (last_day - history_start).days + 1)
    return Window(key, first, last_day, local_midnight(first), end, partial, available)
