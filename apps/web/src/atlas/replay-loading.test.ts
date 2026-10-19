import { beforeEach, expect, it, vi } from "vitest";
import type { Capabilities, TimelineResponse } from "./api";
import { addDays, daysBetween } from "./state";

const get = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ atlasGet: get }));
beforeEach(() => { vi.resetModules(); get.mockReset(); });
const caps = { dataset_id: "jobbank", release_id: "release-1", history_start: "2023-01-01", data_through: "2024-06-01" } as Capabilities;
function chunk(q: Record<string, string>): TimelineResponse {
  return {
    dataset_id: "jobbank", release_id: q.release!, occupation: q.occupation!, window: "30d", data_mode: "real",
    city_ids: ["toronto", "montreal"], start: q.start!, end: q.end!,
    metric: "new_postings", reporting_timezone: "America/Toronto", max_count: 119,
    frames: Array.from({ length: daysBetween(q.start!, q.end!) + 1 }, (_, i) => ({
      date: addDays(q.start!, i), counts: [i, null], national: i + 10, quality: "complete", days_available: 30, backfilled_days: 0, notes: [],
    })),
  };
}
it("bounds concurrency, orders responses, and reuses only matching releases", async () => {
  const { loadReplay, replayPriority } = await import("./replay");
  const pending: (() => void)[] = [];
  let active = 0, peak = 0;
  get.mockImplementation((_path, q) => new Promise(resolve => {
    active++; peak = Math.max(peak, active);
    pending.push(() => { active--; resolve(chunk(q)); });
  }));
  const progress = vi.fn();
  const result = loadReplay(caps, "all", new AbortController().signal, progress);
  expect(get).toHaveBeenCalledTimes(4);
  pending.splice(0).reverse().forEach(resolve => resolve());
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(5));
  pending.splice(0).forEach(resolve => resolve());
  const timeline = await result;
  expect(peak).toBe(4);
  expect(timeline.frames[0]!.date).toBe("2023-01-30");
  expect(timeline.frames.at(-1)!.date).toBe(caps.data_through);
  expect(progress).toHaveBeenLastCalledWith(5, 5);
  expect(replayPriority(timeline)).toEqual([{ id: "toronto", max: 119 }]);
  expect(await loadReplay(caps, "all", new AbortController().signal)).toBe(timeline);
  expect(get).toHaveBeenCalledTimes(5);
  get.mockImplementation(async (_path, q) => chunk(q));
  await loadReplay({ ...caps, release_id: "release-2" }, "all", new AbortController().signal);
  expect(get).toHaveBeenCalledTimes(10);
});
it("cancels the pool and never caches incomplete preparation", async () => {
  const { loadReplay } = await import("./replay");
  const aborted = vi.fn();
  get.mockImplementation((_path, _q, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted(); reject(new DOMException("Aborted", "AbortError")); });
  }));
  const controller = new AbortController();
  const result = loadReplay(caps, "all", controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(aborted).toHaveBeenCalledTimes(4);
  get.mockImplementation(async (_path, q) => chunk(q));
  await loadReplay(caps, "all", new AbortController().signal);
  expect(get).toHaveBeenCalledTimes(9);
});
it("rejects mismatched releases rather than caching or displaying them", async () => {
  const { loadReplay } = await import("./replay");
  get.mockImplementation(async (_path, q) => ({ ...chunk(q), release_id: "wrong" }));
  await expect(loadReplay(caps, "all", new AbortController().signal)).rejects.toThrow("does not match");
});
