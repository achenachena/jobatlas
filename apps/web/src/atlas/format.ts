import type { WindowKey } from "./api";
import { addDays, WINDOW_DAYS } from "./state";

const fmtDate = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtShort = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
const utc = (iso: string) => new Date(`${iso}T12:00:00Z`);
export const fmtDay = (iso: string) => fmtDate.format(utc(iso));
export const fmtNum = (n: number) => n.toLocaleString("en-CA");
export const WINDOW_NAME: Record<WindowKey, string> = { "1d": "1 day", "7d": "7 days", "30d": "30 days" };

/** The counted range, compact: "Sep 24–30, 2026", "Aug 31 – Sep 6, 2026", "Sep 30, 2026". */
export function windowLabel(day: string, w: WindowKey): string {
  if (w === "1d") return fmtDay(day);
  const first = addDays(day, -(WINDOW_DAYS[w] - 1));
  if (first.slice(0, 4) !== day.slice(0, 4)) return `${fmtDay(first)} – ${fmtDay(day)}`;
  if (first.slice(0, 7) === day.slice(0, 7)) return `${fmtShort.format(utc(first))}–${Number(day.slice(8))}, ${day.slice(0, 4)}`;
  return `${fmtShort.format(utc(first))} – ${fmtDay(day)}`;
}
