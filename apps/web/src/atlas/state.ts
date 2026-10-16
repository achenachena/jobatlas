/** One shared selection, mirrored in the URL so a refresh restores it (spec §11).
 * No parameters = Canada, all occupations, last 7 days, latest data, Job Bank (?data=ats:
 * Employer boards, ?data=demo: demo). */
import type { Dataset, WindowKey } from "./api";

export interface Selection {
  dataset: Dataset;
  occupation: string;
  window: WindowKey;
  /** null = follow the latest data ("latest mode"); a date = history mode. */
  date: string | null;
  city: string | null;
  scale: "shared" | "fit";
}

export const DEFAULT_SELECTION: Selection = {
  dataset: "real",
  occupation: "all",
  window: "7d",
  date: null,
  city: null,
  scale: "shared",
};

const WINDOWS: WindowKey[] = ["1d", "7d", "30d"];

export function parseSelection(search: string): Selection {
  const p = new URLSearchParams(search);
  const date = p.get("date");
  return {
    dataset: p.get("data") === "demo" ? "demo" : p.get("data") === "ats" ? "ats" : "real",
    occupation: /^[a-z_]{2,48}$/.test(p.get("occupation") ?? "") ? p.get("occupation")! : "all",
    window: WINDOWS.includes(p.get("window") as WindowKey) ? (p.get("window") as WindowKey) : "7d",
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    city: /^[a-z0-9-]{3,96}$/.test(p.get("city") ?? "") ? p.get("city") : null,
    scale: p.get("scale") === "fit" ? "fit" : "shared",
  };
}

export function serializeSelection(s: Selection): string {
  const p = new URLSearchParams();
  if (s.dataset !== "real") p.set("data", s.dataset);
  if (s.occupation !== "all") p.set("occupation", s.occupation);
  if (s.window !== "7d") p.set("window", s.window);
  if (s.date) p.set("date", s.date);
  if (s.city) p.set("city", s.city);
  if (s.scale !== "shared") p.set("scale", s.scale);
  const q = p.toString();
  return q ? `?${q}` : "";
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}
