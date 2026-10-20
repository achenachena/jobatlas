import type { Dataset, SeriesResponse } from "../api";
import { useCityHistory } from "../useAtlasData";
import s from "./atlas.module.css";

const dateFormat = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtDay = (date: string) => dateFormat.format(new Date(`${date}T12:00:00Z`));
const fmtNum = (count: number) => count.toLocaleString("en-CA");

/** One city's whole history in the replay's release, loaded only when it is opened. */
export function CityHistory(p: { dataset: Dataset; release: string; city: string; occupation: string; start: string; end: string; day: string }) {
  const q = useCityHistory(p.dataset, p.release, p.city, p.occupation, p.start, p.end);
  if (q.isPending) return <p className={s.small}>Loading history…</p>;
  if (q.isError || q.data.release_id !== p.release || q.data.city_id !== p.city)
    return <p className={s.small}>History could not be loaded. <button type="button" className={s.textBtn} onClick={() => void q.refetch()}>Retry</button></p>;
  return <HistoryChart points={q.data.points} day={p.day} />;
}

/** Daily observations of one city up to `day`, never interpolated display values; a point
 * counts only for a complete window (a partial one is unknown, not a smaller number). */
export function HistoryChart({ points: series, day }: { points: SeriesResponse["points"]; day: string }) {
  const points = series.filter(p => p.date <= day).map(p => ({ date: p.date, count: p.quality === "complete" ? p.count ?? null : null, lower: p.backfilled_days > 0 }));
  const known = points.filter(p => p.count != null);
  if (!known.length) return <p className={s.small}>No complete history available for this city.</p>;
  const peak = Math.max(...known.map(p => p.count!));
  const max = Math.max(1, peak);
  const first = Date.parse(points[0]!.date), last = Date.parse(points.at(-1)!.date);
  const x = (date: string) => 35 + (Date.parse(date) - first) / Math.max(1, last - first) * 225;
  const y = (count: number) => 90 - count / max * 76;
  const yearly = last - first >= 730 * 86_400_000;
  const tickDates = yearly
    ? [points[0]!.date, ...Array.from({ length: new Date(last).getUTCFullYear() - new Date(first).getUTCFullYear() }, (_, i) => `${new Date(first).getUTCFullYear() + i + 1}-01-01`)]
    : [...new Set(Array.from({ length: 5 }, (_, i) => points[Math.round(i / 4 * (points.length - 1))]!.date))];
  const ticks = tickDates.filter((date, i) => i === 0 || x(date) - x(tickDates[i - 1]!) >= 35);
  const tickFormat = new Intl.DateTimeFormat("en-CA", yearly ? { year: "numeric", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" });
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
      {ticks.map((date, i) => <g key={date}>
        <line x1={x(date)} x2={x(date)} y1="14" y2="94" className={s.historyGrid} />
        <text x={x(date)} y="104" textAnchor={i === 0 ? "start" : x(date) > 240 ? "end" : "middle"}>{tickFormat.format(new Date(`${date}T12:00:00Z`))}</text>
      </g>)}
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
