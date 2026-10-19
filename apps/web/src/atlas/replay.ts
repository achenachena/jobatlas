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
/** Load bounded chunks, never one request per day; every response is pinned and validated. */
export async function loadReplay(caps: Capabilities, occupation: string, signal: AbortSignal): Promise<TimelineResponse> {
  const start = addDays(caps.history_start!, 29), end = caps.data_through!;
  if (start >= end) throw new Error("Not enough complete 30-day windows for a historical comparison.");
  const chunks: TimelineResponse[] = [];
  for (let day = start; day <= end; day = addDays(day, 120)) {
    const last = addDays(day, 119);
    const part = await atlasGet<TimelineResponse>("/timeline", { dataset: "real", release: caps.release_id!, occupation, window: "30d", start: day, end: last > end ? end : last }, signal);
    if (part.dataset_id !== caps.dataset_id || part.release_id !== caps.release_id || part.occupation !== occupation || part.window !== "30d" || part.data_mode !== "real") throw new Error("History response does not match this selection.");
    if (chunks[0] && part.city_ids.join("|") !== chunks[0].city_ids.join("|")) throw new Error("City coverage changed within the release.");
    chunks.push(part);
  }
  const frames = chunks.flatMap(c => c.frames);
  if (frames.length !== daysBetween(start, end) + 1 || frames.some((f, i) => f.date !== addDays(start, i))) throw new Error("History contains missing dates. Please retry after the data is repaired.");
  const first = frames.findIndex(completeFrame);
  let last = frames.length - 1;
  while (last >= 0 && !completeFrame(frames[last]!)) last--;
  if (first < 0 || last <= first) throw new Error("Not enough complete windows for a historical comparison.");
  return { ...chunks[0]!, start: frames[first]!.date, end: frames[last]!.date, frames: frames.slice(first, last + 1) };
}
/** Sampling uses real dates, with a stable endpoint and a bounded number of visible frames. */
export function replayIndex(progress: number, length: number): number {
  const steps = Math.min(119, length - 1);
  return Math.round(Math.floor(Math.min(1, Math.max(0, progress)) * steps) / steps * (length - 1));
}
