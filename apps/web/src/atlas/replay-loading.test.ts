import { beforeEach, expect, it, vi } from "vitest";
import type { Capabilities, OverviewResponse } from "./api";

const get = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ atlasGet: get }));
beforeEach(() => { vi.resetModules(); get.mockReset(); });
const caps = { dataset_id: "jobbank", release_id: "release-1", history_start: "2023-01-01", data_through: "2024-06-01" } as Capabilities;
function overview(q: Record<string, string>, patch: Partial<OverviewResponse> = {}): OverviewResponse {
  const frame = (date: string, toronto: number) => ({ date, counts: [toronto, 0], national: toronto + 10, quality: "complete" as const, days_available: 30, backfilled_days: 0, notes: [] });
  return {
    format: 1, dataset_id: "jobbank", data_mode: "real", release_id: q.release!, occupation: q.occupation!, window: "30d",
    start: "2023-01-30", end: "2024-06-01", history_start: "2023-01-01", data_through: "2024-06-01", scale_max: 119, samples: 120,
    city_ids: ["toronto", "montreal"], city_max: [119, 4], incomplete: [],
    frames: [frame("2023-01-30", 3), frame("2023-09-01", 7), frame("2024-06-01", 9)], ...patch,
  };
}
it("prepares with one request, keeps whole-range priority, and reuses recent selections only", async () => {
  const { loadOverview } = await import("./replay");
  get.mockImplementation(async (_path, q) => overview(q));
  const ov = await loadOverview(caps, "all", new AbortController().signal);
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0]![1]).toEqual({ dataset: "real", release: "release-1", occupation: "all", window: "30d" });
  // montreal never shows in a sampled frame, yet keeps its place from the whole range
  expect(ov.priority).toEqual([{ id: "toronto", max: 119 }, { id: "montreal", max: 4 }]);
  expect(await loadOverview(caps, "all", new AbortController().signal)).toBe(ov);
  await loadOverview({ ...caps, release_id: "release-2" }, "all", new AbortController().signal);
  expect(get).toHaveBeenCalledTimes(2);
  // a bounded number of selections: the least recently used one is dropped
  for (const occ of ["a", "b", "c", "d", "e"]) await loadOverview(caps, occ, new AbortController().signal);
  expect(get).toHaveBeenCalledTimes(7);
  await loadOverview(caps, "all", new AbortController().signal); // release-1/all was used before release-2: dropped
  expect(get).toHaveBeenCalledTimes(8);
  await loadOverview(caps, "e", new AbortController().signal);
  expect(get).toHaveBeenCalledTimes(8);
});
it("rejects responses for another selection or with inconsistent frames, and keeps none", async () => {
  const { loadOverview } = await import("./replay");
  const bad: Partial<OverviewResponse>[] = [
    { release_id: "wrong" }, { occupation: "cook" }, { window: "7d" },
    { city_max: [1] }, { end: "2024-05-31" },
  ];
  for (const patch of bad) {
    get.mockImplementationOnce(async (_path, q) => overview(q, patch));
    await expect(loadOverview(caps, "all", new AbortController().signal)).rejects.toThrow();
  }
  get.mockImplementationOnce(async (_path, q) => { const o = overview(q); o.frames[1]!.counts = [1]; return o; });
  await expect(loadOverview(caps, "all", new AbortController().signal)).rejects.toThrow("incomplete");
  get.mockImplementationOnce(async (_path, q) => { const o = overview(q); o.frames[1]!.date = "2023-01-30"; return o; });
  await expect(loadOverview(caps, "all", new AbortController().signal)).rejects.toThrow("incomplete");
  get.mockImplementationOnce(async (_path, q) => { const o = overview(q); o.frames[0]!.quality = "partial"; return o; });
  await expect(loadOverview(caps, "all", new AbortController().signal)).rejects.toThrow("complete windows");
  get.mockImplementation(async (_path, q) => overview(q));
  await loadOverview(caps, "all", new AbortController().signal);
  expect(get).toHaveBeenCalledTimes(bad.length + 4); // nothing rejected was kept
});
it("cancelling leaves nothing prepared", async () => {
  const { loadOverview } = await import("./replay");
  get.mockImplementation((_path, _q, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  const controller = new AbortController();
  const result = loadOverview(caps, "all", controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  get.mockImplementation(async (_path, q) => overview(q));
  await loadOverview(caps, "all", new AbortController().signal);
  expect(get).toHaveBeenCalledTimes(2);
});
