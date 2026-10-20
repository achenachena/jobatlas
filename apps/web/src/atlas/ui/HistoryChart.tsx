import type { TimelineResponse } from "../api";
import s from "./atlas.module.css";

const dateFormat = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtDay = (date: string) => dateFormat.format(new Date(`${date}T12:00:00Z`));
const fmtNum = (count: number) => count.toLocaleString("en-CA");

/** Use the prepared release's daily observations, never interpolated display values. */
export function HistoryChart({ timeline, cityId, day }: { timeline: TimelineResponse; cityId: string; day: string }) {
  const city = timeline.city_ids.indexOf(cityId);
  const frames = timeline.frames.filter(frame => frame.date <= day);
  const points = frames.map(frame => ({ date: frame.date, count: frame.quality === "complete" && frame.days_available === 30 ? frame.counts[city] ?? null : null, lower: frame.backfilled_days > 0 }));
  const known = points.filter(p => p.count != null);
  if (!known.length) return <p className={s.small}>No complete history available for this city.</p>;
  const peak = Math.max(...known.map(p => p.count!));
  const max = Math.max(1, peak);
  const first = Date.parse(points[0]!.date), last = Date.parse(points.at(-1)!.date);
  const x = (date: string) => 35 + (Date.parse(date) - first) / Math.max(1, last - first) * 225;
  const y = (count: number) => 90 - count / max * 76;
  let solid = "", lower = "";
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    if (a.count == null || b.count == null || Date.parse(b.date) - Date.parse(a.date) !== 86_400_000) continue;
    const segment = `M${x(a.date).toFixed(2)},${y(a.count).toFixed(2)}L${x(b.date).toFixed(2)},${y(b.count).toFixed(2)}`;
    if (a.lower || b.lower) lower += segment; else solid += segment;
  }
  const end = points.at(-1)!;
  const gaps = known.length !== points.length || points.some((p, i) => i > 0 && Date.parse(p.date) - Date.parse(points[i - 1]!.date) !== 86_400_000);
  return <figure className={s.cityHistory}>
    <svg viewBox="0 0 270 106" role="img" aria-label={`Posting history for this city, ${fmtDay(points[0]!.date)} to ${fmtDay(end.date)}. Peak ${fmtNum(peak)} postings. Each point is a past-30-day window.${gaps ? " Gaps are not connected." : ""}`}>
      <path d="M35 14H260M35 90H260" className={s.historyGrid} />
      <text x="29" y="18" textAnchor="end">{fmtNum(max)}</text><text x="29" y="94" textAnchor="end">0</text>
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
        <path d={solid} /><path d={lower} strokeDasharray="3 3" />
      </g>
      {end.count != null && <circle cx={x(end.date)} cy={y(end.count)} r="2.5" fill="currentColor" />}
      {points.map((point, i) => point.count != null && point !== end && points[i - 1]?.count == null && points[i + 1]?.count == null
        ? <circle key={point.date} cx={x(point.date)} cy={y(point.count)} r="2" fill="currentColor" /> : null)}
    </svg>
    <figcaption><span>{fmtDay(points[0]!.date)}</span><span>{fmtDay(end.date)}</span></figcaption>
    <p>New postings · Rolling 30-day windows{gaps && " · Gaps = unavailable data"}{lower && " · Dashed = lower bounds"}</p>
  </figure>;
}
