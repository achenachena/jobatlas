import { project } from "./projection";
import { heightFor, legendTicks, MAX_HEIGHT, colorFor, POSTING_COLORS } from "./scale";
import { addDays, daysBetween, DEFAULT_SELECTION, parseSelection, serializeSelection } from "./state";
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

test("colour uses the same fixed count scale across cities and frames", () => {
  expect(colorFor(0, 400)).toBe(POSTING_COLORS[0]);
  expect(colorFor(null, 400)).toBe(POSTING_COLORS[0]);
  expect(colorFor(100, 400)).toBe(POSTING_COLORS[1]);
  expect(colorFor(400, 400)).toBe(POSTING_COLORS[2]);
  expect(colorFor(800, 400)).toBe(POSTING_COLORS[2]);
  expect(colorFor(25, 100)).toBe(colorFor(100, 400));
});
