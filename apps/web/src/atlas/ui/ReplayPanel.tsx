import { useState } from "react";
import type { City, TimelineResponse } from "../api";
import { changeLabel, REFERENCE_CITIES, type ReplayFrame } from "../replay";
import { addDays } from "../state";
import { fmtDay, fmtNum } from "./parts";
import s from "./atlas.module.css";

export function ReplayPanel(p: {
  day: string | null; windowDays: number; national: number | null | undefined; counts: Map<string, number | null>;
  baseline?: ReplayFrame; timeline?: TimelineResponse; selected: City | null; dataset: string;
  compare: boolean; onCompare: (value: boolean) => void; ended: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const base = new Map(p.timeline?.city_ids.map((id,i) => [id, p.baseline?.counts[i] ?? null]));
  const rows: (readonly [string,string])[] = [...REFERENCE_CITIES];
  if (p.selected && !rows.some(([id]) => id === p.selected!.city_id)) rows.push([p.selected.city_id, p.selected.name]);
  const delta = p.baseline?.national != null && p.national != null ? p.national - p.baseline.national : null;
  return <aside className={`${s.replayPanel} ${expanded ? s.replayExpanded : ""}`} aria-label="Postings summary">
    <div className={s.replayHeading}><strong>CANADA</strong><span>Past {p.windowDays} days</span></div>

    <div className={s.replayTotal} data-testid="national-total">{p.national == null ? "—" : fmtNum(p.national)}</div>
    {p.national == null && <div className={s.small}>No complete total available for this frame</div>}
    {p.baseline && <div className={s.replayDelta} data-testid="national-change">{delta == null ? "Not comparable" : `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${fmtNum(Math.abs(delta))} · ${changeLabel(p.baseline.national, p.national)}`} vs start</div>}
    <table><thead><tr><th>City</th><th>Postings</th><th>Change</th></tr></thead><tbody>
      {rows.map(([id,name], i) => <tr key={id} className={i >= 3 ? s.replayExtra : undefined} title={p.baseline && base.get(id) != null && p.counts.get(id) != null ? `Start ${base.get(id)}; current ${p.counts.get(id)}; difference ${p.counts.get(id)! - base.get(id)!} advertisements` : undefined}>
        <th scope="row">{name}</th><td>{p.counts.get(id) == null ? "—" : fmtNum(p.counts.get(id)!)}</td><td>{p.baseline ? changeLabel(base.get(id), p.counts.get(id)) : "—"}</td>
      </tr>)}
    </tbody></table>
    <button type="button" className={s.replayExpand} onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? "Fewer cities" : "Show all cities & details"}</button>
    {p.baseline && <><label className={s.compareToggle}><input type="checkbox" checked={p.compare} onChange={e => p.onCompare(e.target.checked)} />Compare with start</label>
      <div className={`${s.small} ${s.replayBaseline}`}>Compared with {fmtDay(p.baseline.date)}</div>
      <details className={s.replayDetails}><summary>Comparison dates & meaning</summary><p>Start: {addDays(p.baseline.date,-29)} – {p.baseline.date}<br/>Current: {p.day && addDays(p.day,-29)} – {p.day}</p><p>Short tick = start height; solid = current. Teal above start means increase; a warm vertical stem shows the decrease. Window differences are not seasonally adjusted trends.</p></details></>}
    <details className={s.replayDetails}><summary>Source & counting details</summary><p className={`${s.small} ${s.replayFootnote}`}>As of {p.day ? fmtDay(p.day) : "loading"}. New postings. Source: {p.dataset}. National totals include records without a confirmed city. Counts are new advertisements, not people hired or active jobs.</p></details>
  </aside>;
}
