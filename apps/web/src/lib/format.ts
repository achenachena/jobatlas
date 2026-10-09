import type { JobCard } from "./api";
import { t } from "./strings";

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 hours ago" style text; null in, null out — never a made-up time. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const minutes = Math.round((then - now) / 60000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  return rtf.format(Math.round(hours / 24), "day");
}

export function postedText(job: Pick<JobCard, "posted_at" | "posted_date" | "posted_basis" | "posted_precision">): string {
  if (job.posted_basis === "republished_only") return t.republishedOnly;
  if (job.posted_precision === "datetime" && job.posted_at) return `Posted ${relativeTime(job.posted_at)}`;
  if (job.posted_precision === "date" && job.posted_date) {
    const d = new Date(`${job.posted_date}T12:00:00`);
    return `Posted ${d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return t.postedUnknown;
}

export function salaryText(s: JobCard["salary"]): string | null {
  if (!s) return null;
  if (s.min == null && s.max == null) return s.raw_text ?? null;
  const fmt = new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: s.currency ?? "CAD",
    maximumFractionDigits: s.period === "hour" ? 2 : 0,
  });
  const range = s.min != null && s.max != null && s.min !== s.max
    ? `${fmt.format(s.min)}–${fmt.format(s.max)}`
    : fmt.format((s.min ?? s.max) as number);
  return s.period ? `${range} / ${s.period}` : range;
}

/** Only real http(s) links are ever used as Apply targets. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
