import { atlasGet, type Capabilities, type TimelineResponse } from "./api";
import { addDays, daysBetween } from "./state";

export type ReplayFrame = TimelineResponse["frames"][number];
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
// Keep one validated release/selection in memory; revisiting it needs no network round trip.
let prepared: { key: string; timeline: TimelineResponse } | undefined;

/** Load a bounded pool of chunks; preserve date order and validate the entire release. */
export async function loadReplay(caps: Capabilities, occupation: string, signal: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<TimelineResponse> {
  const start = addDays(caps.history_start!, 29), end = caps.data_through!;
  if (start >= end) throw new Error("Not enough complete 30-day windows for a historical comparison.");
  const key = JSON.stringify([caps.dataset_id, caps.release_id, occupation, start, end]);
  signal.throwIfAborted();
  if (prepared?.key === key) { onProgress?.(1, 1); return prepared.timeline; }
  const ranges: [string, string][] = [];
  for (let day = start; day <= end; day = addDays(day, 120)) {
    const last = addDays(day, 119);
    ranges.push([day, last > end ? end : last]);
  }
  const chunks = new Array<TimelineResponse>(ranges.length);
  const pool = new AbortController();
  const abort = () => pool.abort();
  signal.addEventListener("abort", abort, { once: true });
  let next = 0, done = 0;
  onProgress?.(0, ranges.length);
  try {
    await Promise.all(Array.from({ length: Math.min(4, ranges.length) }, async () => {
      while (next < ranges.length) {
        pool.signal.throwIfAborted();
        const index = next++, [first, last] = ranges[index]!;
        const part = await atlasGet<TimelineResponse>("/timeline", { dataset: "real", release: caps.release_id!, occupation, window: "30d", start: first, end: last }, pool.signal);
        if (part.dataset_id !== caps.dataset_id || part.release_id !== caps.release_id || part.occupation !== occupation || part.window !== "30d" || part.data_mode !== "real") throw new Error("History response does not match this selection.");
        chunks[index] = part;
        onProgress?.(++done, ranges.length);
      }
    }));
  } finally {
    pool.abort();
    signal.removeEventListener("abort", abort);
  }
  signal.throwIfAborted();
  if (chunks.some(part => part.city_ids.join("|") !== chunks[0]!.city_ids.join("|"))) throw new Error("City coverage changed within the release.");
  const frames = chunks.flatMap(c => c.frames);
  if (frames.length !== daysBetween(start, end) + 1 || frames.some((f, i) => f.date !== addDays(start, i))) throw new Error("History contains missing dates. Please retry after the data is repaired.");
  const first = frames.findIndex(completeFrame);
  let last = frames.length - 1;
  while (last >= 0 && !completeFrame(frames[last]!)) last--;
  if (first < 0 || last <= first) throw new Error("Not enough complete windows for a historical comparison.");
  const timeline = { ...chunks[0]!, start: frames[first]!.date, end: frames[last]!.date, frames: frames.slice(first, last + 1) };
  prepared = { key, timeline };
  return timeline;
}
/** Sampling uses real dates, with a stable endpoint and a bounded number of visible frames. */
export function replayIndex(progress: number, length: number): number {
  const steps = Math.min(119, length - 1);
  return Math.round(Math.floor(Math.min(1, Math.max(0, progress)) * steps) / steps * (length - 1));
}

/** Scan rows once without allocating one temporary array per city. */
export function replayPriority(timeline: TimelineResponse): { id: string; max: number }[] {
  const maxima = new Float64Array(timeline.city_ids.length);
  for (const frame of timeline.frames)
    for (let i = 0; i < maxima.length; i++) maxima[i] = Math.max(maxima[i]!, frame.counts[i] ?? 0);
  return timeline.city_ids.map((id, i) => ({ id, max: maxima[i]! })).filter(p => p.max > 0).sort((a,b) => b.max - a.max || a.id.localeCompare(b.id));
}
