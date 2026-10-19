import { project } from "./projection";
import { cityScaleMax, heightFor, legendTicks, MAX_HEIGHT } from "./scale";
import { addDays, daysBetween, DEFAULT_SELECTION, parseSelection, serializeSelection } from "./state";
import { windowLabel } from "./ui/parts";
import { chunkFor, CHUNK_DAYS } from "./useAtlasData";

test("height is monotonic, square-root, and fixed by the playback scale", () => {
  const scale = 400;
  let prev = -1;
  for (let c = 0; c <= 400; c += 7) {
    const h = heightFor(c, scale);
    expect(h).toBeGreaterThanOrEqual(prev); // more postings never lower
    prev = h;
  }
  expect(heightFor(400, scale)).toBeCloseTo(MAX_HEIGHT);
  expect(heightFor(100, scale)).toBeCloseTo(MAX_HEIGHT / 2); // 4x postings = 2x height
  expect(heightFor(0, scale)).toBe(0); // real zero: no tower
  expect(heightFor(null, scale)).toBe(0); // unknown: no tower (drawn as a ring)
});

test("positive counts have continuous crystal heights without floor rounding", () => {
  expect(heightFor(1, 10_000)).toBeGreaterThan(0);
  expect(heightFor(2, 10_000)).toBeGreaterThan(heightFor(1, 10_000));
});

test("legend ticks are increasing and within the scale", () => {
  const t = legendTicks(545);
  expect(t).toEqual([...t].sort((a, b) => a - b));
  expect(t.at(-1)).toBe(545);
});

test("no URL parameters = Canada, all jobs, last 7 days, latest, real data", () => {
  expect(parseSelection("")).toEqual(DEFAULT_SELECTION);
  expect(serializeSelection(DEFAULT_SELECTION)).toBe("");
});

test("Employer boards is ?data=ats; no parameter is Job Bank", () => {
  expect(parseSelection("?data=ats").dataset).toBe("ats");
  expect(serializeSelection({ ...DEFAULT_SELECTION, dataset: "ats" })).toBe("?data=ats");
  expect(parseSelection("").dataset).toBe("real");
  expect(parseSelection("?data=boards").dataset).toBe("real");
});

test("selection round-trips through the URL; invalid values fall back", () => {
  const s = { ...DEFAULT_SELECTION, occupation: "bartender", window: "30d" as const, date: "2025-07-01", city: "ca-on-toronto" };
  expect(parseSelection(serializeSelection(s))).toEqual(s);
  const bad = parseSelection("?window=9d&date=yesterday&occupation=%3Cscript%3E&data=prod");
  expect(bad).toEqual(DEFAULT_SELECTION);
});

test("timeline chunks are aligned to the history and never pass the data", () => {
  const start = "2023-01-01";
  const through = "2026-09-30";
  const [a, b] = chunkFor("2023-01-05", start, through);
  expect(a).toBe(start);
  expect(daysBetween(a, b)).toBe(CHUNK_DAYS - 1);
  const [c, d] = chunkFor(through, start, through);
  expect(d).toBe(through);
  expect(daysBetween(c, through)).toBeLessThan(CHUNK_DAYS);
  expect(chunkFor(addDays(b, 1), start, through)[0]).toBe(addDays(b, 1));
});

test("projection keeps relative city positions", () => {
  const [tx, ty] = project(-79.38, 43.65); // Toronto
  const [vx] = project(-123.12, 49.28); // Vancouver
  const [mx, my] = project(-73.57, 45.5); // Montréal
  expect(vx).toBeLessThan(tx);
  expect(mx).toBeGreaterThan(tx);
  expect(my).toBeGreaterThan(ty);
});

test("counts above the playback scale grow taller instead of being clamped", () => {
  expect(MAX_HEIGHT).toBe(1350);
  expect(heightFor(400, 400)).toBeCloseTo(MAX_HEIGHT);
  expect(heightFor(1600, 400)).toBeCloseTo(MAX_HEIGHT * 2);
});

test("the same count has the same height on any date or occupation under one scale", () => {
  expect(heightFor(37, 545)).toBe(heightFor(37, 545));
  expect(heightFor(37, 545)).not.toBe(heightFor(37, 600)); // only a new scale changes it
});

test("date range labels are compact and keep day granularity", () => {
  expect(windowLabel("2026-09-30", "7d")).toBe("Sep 24–30, 2026");
  expect(windowLabel("2026-09-06", "7d")).toBe("Aug 31 – Sep 6, 2026");
  expect(windowLabel("2026-01-03", "7d")).toBe("Dec 28, 2025 – Jan 3, 2026");
  expect(windowLabel("2026-09-30", "1d")).toBe("Sep 30, 2026");
});


test("city scale uses occupation/window maxima and preserves zero without accepting invalid metadata", () => {
  const quality = { scale_max: { all: { "7d": 2929, "30d": 9699 }, cook: { "7d": 105, "1d": 0 } }, group_scale_max: { values: { all: { "7d": 10832 } } } };
  expect(cityScaleMax(quality, "all", "7d")).toBe(2929);
  expect(cityScaleMax(quality, "all", "30d")).toBe(9699);
  expect(cityScaleMax(quality, "cook", "7d")).toBe(105);
  expect(cityScaleMax(quality, "cook", "1d")).toBe(0);
  for (const value of [undefined, {}, { scale_max: null }, { scale_max: { all: { "7d": "2929" } } }, { scale_max: { all: { "7d": -1 } } }, { scale_max: { all: { "7d": Infinity } } }])
    expect(cityScaleMax(value, "all", "7d")).toBeNull();
});
