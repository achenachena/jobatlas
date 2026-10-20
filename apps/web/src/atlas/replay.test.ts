import { describe, expect, it } from "vitest";
import { changeLabel, completeFrame, replayIndex, type ReplayFrame } from "./replay";

describe("historical comparison", () => {
  it("keeps zero and unavailable baselines distinct", () => {
    expect(changeLabel(null, 10)).toBe("Not comparable");
    expect(changeLabel(10, null)).toBe("Not comparable");
    expect(changeLabel(0, 10)).toBe("0 → 10");
    expect(changeLabel(0, 0)).toBe("No change");
    expect(changeLabel(100, 76)).toBe("−24.0%");
    expect(changeLabel(100, 125)).toBe("+25.0%");
  });
  it("samples actual indices over elapsed time, with exact endpoints", () => {
    expect(replayIndex(0, 1370)).toBe(0);
    expect(replayIndex(1, 1370)).toBe(1369);
    expect(replayIndex(1.2, 1370)).toBe(1369);
    expect(replayIndex(.5, 1370)).toBeGreaterThan(660);
    expect(replayIndex(.5, 1370)).toBeLessThan(700);
  });
  it("rejects gaps, partial windows, backfills and missing national totals", () => {
    const f: ReplayFrame = { date: "2023-01-30", counts: [1], national: 12, quality: "complete", days_available: 30, backfilled_days: 0, notes: [] };
    expect(completeFrame(f)).toBe(true);
    for (const patch of [{quality:"missing"}, {days_available:29}, {backfilled_days:1}, {national:null}]) expect(completeFrame({...f,...patch} as ReplayFrame)).toBe(false);
  });
});
