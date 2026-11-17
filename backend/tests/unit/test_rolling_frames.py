"""Compare replay windows with independent, direct sums at coverage boundaries."""

from datetime import date, timedelta

import pytest

from app.atlas.metrics import rolling_frames
from app.atlas.windows import WINDOWS, window


@pytest.mark.parametrize("window_key", WINDOWS)
@pytest.mark.parametrize("start_offset", [-3, 0, 35])
def test_rolling_frames_match_direct_windows(window_key, start_offset):
    history = date(2026, 3, 1)  # includes the Toronto DST transition
    days = [history + timedelta(days=i) for i in range(100)]
    gaps = {days[i] for i in (6, 7, 36, 70)}
    backfilled = set(days[:8]) | {days[35], days[36]}
    daily = {
        day: {("city", "a"): i % 5, ("national", ""): i % 5 + 3,
              ("remote", ""): 2, ("unconfirmed", ""): 1}
        for i, day in enumerate(days) if day not in gaps and i % 7 != 0
    }
    first = history + timedelta(days=start_offset)
    frames = rolling_frames(
        first, days[-1], window_key, history, gaps, daily, ["a", "empty", "uncovered"],
        not_covered={"uncovered"}, partial_on=days[-1], backfilled=backfilled,
    )
    assert len(frames) == (days[-1] - first).days + 1
    n = WINDOWS[window_key]
    for i, frame in enumerate(frames):
        day = first + timedelta(days=i)
        span = {day - timedelta(days=j) for j in range(n)}
        missing = len(span & gaps)
        filled = len(span & backfilled)
        available = window(window_key, day, history_start=history).days_available
        notes = []
        quality = "complete"
        if missing:
            quality = "missing"
            notes.append(f"{missing} day(s) of this window are not covered")
        elif available < n:
            quality = "partial"
            notes.append(f"only {available} of {n} days have data (history starts {history})")
        if day == days[-1]:
            notes.append("today is not over")
            if quality == "complete":
                quality = "partial"
        if filled:
            notes.append(f"{filled} day(s) of this window are backfilled from postings still "
                         "open when collection started: lower bounds")
        assert frame.day == day
        assert frame.quality == quality
        assert frame.days_available == available
        assert frame.backfilled_days == filled
        assert frame.notes == notes
        totals = {
            key: sum(values.get(key, 0) for d, values in daily.items() if d in span)
            for key in [("city", "a"), ("national", ""), ("remote", ""), ("unconfirmed", "")]
        }
        assert frame.cities == {
            "a": None if missing else totals[("city", "a")],
            "empty": None if missing else 0,
            "uncovered": None,
        }
        assert (frame.national, frame.remote, frame.unconfirmed) == (
            (None, None, None) if missing else
            (totals[("national", "")], totals[("remote", "")], totals[("unconfirmed", "")]))


def test_empty_replay_range():
    assert rolling_frames(date(2026, 1, 2), date(2026, 1, 1), "30d",
                          date(2026, 1, 1), set(), {}, []) == []
