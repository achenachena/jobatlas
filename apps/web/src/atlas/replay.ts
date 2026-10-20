import { atlasGet, type Capabilities, type OverviewResponse } from "./api";
import { daysBetween } from "./state";

export type ReplayFrame = OverviewResponse["frames"][number];
export const REFERENCE_CITIES = [
  ["ca-on-toronto", "Toronto"], ["ca-qc-montreal", "Montréal"], ["ca-bc-vancouver", "Vancouver"],
  ["ca-ab-calgary", "Calgary"], ["ca-ab-edmonton", "Edmonton"],
] as const;
export function changeLabel(start: number | null | undefined, current: number | null | undefined): string {
  if (start == null || current == null) return "Not comparable";
  if (start === current) return "No change";
  if (start === 0) return `0 → ${current.toLocaleString("en-CA")}`;
  const percent = (current - start) / start * 100;
  return `${percent > 0 ? "+" : "−"}${Math.abs(percent).toFixed(1)}%`;
}
export function completeFrame(f: ReplayFrame): boolean {
  return f.quality === "complete" && f.days_available === 30 && f.backfilled_days === 0 && f.national != null;
}

/** A validated overview: real dates sampled over one release's complete 30-day windows. */
export interface Overview extends OverviewResponse {
  /** whole-range drawing priority (every day counted, not only sampled ones) */
  priority: { id: string; max: number }[];
}

// The last few prepared overviews stay in memory, so switching occupations and back needs no
// request; across reloads, release-pinned responses are immutable and the HTTP cache keeps them.
const KEEP = 6;
const prepared = new Map<string, Overview>();

export function overviewKey(caps: Capabilities, occupation: string): string {
  return JSON.stringify([caps.dataset_id, caps.release_id, occupation, "30d"]);
}

/** One request for the whole overview; anything that does not match the selection or is not
 * a consistent, date-ordered series is rejected, never shown. */
export async function loadOverview(caps: Capabilities, occupation: string, signal: AbortSignal): Promise<Overview> {
  const key = overviewKey(caps, occupation);
  const hit = prepared.get(key);
  if (hit) {
    prepared.delete(key); prepared.set(key, hit); // most recently used last
    return hit;
  }
  const ov = await atlasGet<OverviewResponse>("/overview", { dataset: "real", release: caps.release_id!, occupation, window: "30d" }, signal);
  signal.throwIfAborted();
  if (ov.dataset_id !== caps.dataset_id || ov.release_id !== caps.release_id || ov.occupation !== occupation || ov.window !== "30d" || ov.data_mode !== "real")
    throw new Error("History response does not match this selection.");
  const n = ov.city_ids.length;
  if (ov.city_max.length !== n || ov.frames.length < 2 || ov.frames[0]!.date !== ov.start || ov.frames.at(-1)!.date !== ov.end
    || ov.frames.some((f, i) => f.counts.length !== n || (i > 0 && f.date <= ov.frames[i - 1]!.date)))
    throw new Error("History response is incomplete. Please retry.");
  if (!completeFrame(ov.frames[0]!) || !completeFrame(ov.frames.at(-1)!)) throw new Error("Not enough complete windows for a historical comparison.");
  const priority = ov.city_ids.map((id, i) => ({ id, max: ov.city_max[i]! })).filter(p => p.max > 0)
    .sort((a, b) => b.max - a.max || (a.id < b.id ? -1 : 1));
  const overview = { ...ov, priority };
  prepared.set(key, overview);
  while (prepared.size > KEEP) prepared.delete(prepared.keys().next().value!);
  return overview;
}

/** The frame shown at a point of the playback: the last frame whose real date has been
 * reached, with time proportional to the dates (gap boundaries do not bend the pace). */
export function replayIndex(progress: number, frames: { date: string }[]): number {
  const span = daysBetween(frames[0]!.date, frames.at(-1)!.date);
  const target = Math.min(1, Math.max(0, progress)) * span;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (daysBetween(frames[0]!.date, frames[mid]!.date) <= target) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Playback progress (0–1) at a frame's date. */
export function replayProgress(frames: { date: string }[], index: number): number {
  const span = daysBetween(frames[0]!.date, frames.at(-1)!.date);
  return span ? daysBetween(frames[0]!.date, frames[index]!.date) / span : 0;
}
