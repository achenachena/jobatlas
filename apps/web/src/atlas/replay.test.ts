import { describe, expect, it } from "vitest";
import { changeLabel, completeFrame, replayIndex, replayProgress, type ReplayFrame } from "./replay";

describe("historical comparison", () => {
  it("keeps zero and unavailable baselines distinct", () => {
    expect(changeLabel(null, 10)).toBe("Not comparable");
    expect(changeLabel(10, null)).toBe("Not comparable");
    expect(changeLabel(0, 10)).toBe("0 → 10");
    expect(changeLabel(0, 0)).toBe("No change");
    expect(changeLabel(100, 76)).toBe("−24.0%");
    expect(changeLabel(100, 125)).toBe("+25.0%");
  });
  it("moves through real dates in proportion to time, with exact endpoints", () => {
    // uneven spacing, as when a gap's first day and the day after it are added
    const frames = ["2023-01-01", "2023-01-11", "2023-01-12", "2023-01-13", "2023-01-31", "2023-02-10"].map(date => ({ date }));
    expect(replayIndex(0, frames)).toBe(0);
    expect(replayIndex(1, frames)).toBe(5);
    expect(replayIndex(1.2, frames)).toBe(5);
    expect(replayIndex(10 / 40, frames)).toBe(1); // day 10 of 40 reaches Jan 11 exactly
    expect(replayIndex(11.9 / 40, frames)).toBe(2); // not yet Jan 13
    expect(replayIndex(0.5, frames)).toBe(3); // day 20: last frame reached is Jan 13
    expect(replayProgress(frames, 4)).toBe(30 / 40);
  });
  it("rejects gaps, partial windows, backfills and missing national totals", () => {
    const f: ReplayFrame = { date: "2023-01-30", counts: [1], national: 12, quality: "complete", days_available: 30, backfilled_days: 0, notes: [] };
    expect(completeFrame(f)).toBe(true);
    for (const patch of [{quality:"missing"}, {days_available:29}, {backfilled_days:1}, {national:null}]) expect(completeFrame({...f,...patch} as ReplayFrame)).toBe(false);
  });
});
