/** Atlas controls and panels. English UI (spec §7.3); city names keep their own spelling. */
import { useEffect, useId, useRef } from "react";

import type { Capabilities, City, SeriesResponse, SourcesResponse, WindowKey } from "../api";
import { colorFor, legendTicks, POSTING_COLORS } from "../scale";
import { addDays } from "../state";
import s from "./atlas.module.css";

const fmtDate = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtShort = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
export const fmtDay = (iso: string) => fmtDate.format(new Date(`${iso}T12:00:00Z`));
export const fmtNum = (n: number) => n.toLocaleString("en-CA");
const WINDOW_DAYS: Record<WindowKey, number> = { "1d": 1, "7d": 7, "30d": 30 };

export function windowLabel(day: string, w: WindowKey): string {
  if (w === "1d") return fmtDay(day);
  const first = addDays(day, -(WINDOW_DAYS[w] - 1));
  return `${fmtShort.format(new Date(`${first}T12:00:00Z`))} – ${fmtDay(day)}`;
}

export const OCC_SHORT: Record<string, string> = {
  all: "All jobs",
  software_development: "Software dev",
  human_resources: "HR",
  bartender: "Bartender",
  barista: "Barista",
  registered_nurse: "Nurse (RN)",
  cook: "Cook",
};

export function TopBar(p: {
  caps: Capabilities | undefined;
  occupation: string;
  window: WindowKey;
  onOccupation: (id: string) => void;
  onWindow: (w: WindowKey) => void;
  demo: boolean;
}) {
  const occs = p.caps?.occupations ?? [{ id: "all", label: "All jobs", note: "" }];
  return (
    <header className={s.top}>
      <div className={`${s.panel} ${s.brand}`}>
        <h1 className={s.brandName} style={{ margin: 0, fontWeight: 400 }}>
          Job<span>Atlas</span> <small style={{ fontSize: 13 }}>Canada</small>
        </h1>
        <span className={s.brandNote}>
          Crystal height = job postings first published on Job Bank in the selected window, by city.
          Not hires, not all vacancies.
        </span>
        {p.demo && (
          <div className={s.badge} role="status">
            Demo data · 示例数据 — generated, not real postings
          </div>
        )}
      </div>
      <div className={`${s.panel} ${s.controls}`}>
        <div className={s.chips} role="radiogroup" aria-label="Occupation">
          {occs.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={p.occupation === o.id}
              className={s.chip}
              title={o.note}
              onClick={() => p.onOccupation(o.id)}
            >
              {OCC_SHORT[o.id] ?? o.label}
            </button>
          ))}
        </div>
        <div className={s.segment} role="radiogroup" aria-label="Time window">
          {(["1d", "7d", "30d"] as WindowKey[]).map((w) => (
            <button key={w} type="button" role="radio" aria-checked={p.window === w} className={s.chip} onClick={() => p.onWindow(w)}>
              {w === "1d" ? "1 day" : w === "7d" ? "7 days" : "30 days"}
            </button>
          ))}
        </div>
      </div>

    </header>
  );
}

export function Legend(p: { scaleMax: number | null; mode: "shared" | "fit"; occupationLabel: string; onMode: (m: "shared" | "fit") => void }) {
  const ticks = p.scaleMax ? legendTicks(p.scaleMax) : [];
  const max = p.scaleMax ?? 1;
  return (
    <section className={`${s.panel} ${s.legend}`} aria-label="Legend">
      <h2>Job postings</h2>
      <p className={s.legendLead}>Taller + warmer = more jobs</p>
      <div className={s.ticks} aria-hidden="true">
        {ticks.map((t) => (
          <div key={t} className={s.tick}>
            <div className={s.tickBar} style={{ height: `${Math.max(6, 48 * Math.sqrt(t / max))}px`, backgroundColor: colorFor(t, max) }} />
            {fmtNum(t)}
          </div>
        ))}
      </div>
      <div className={s.colorRamp} style={{ background: `linear-gradient(90deg, ${POSTING_COLORS.join(", ")})` }} aria-hidden="true" />
      <div className={s.colorEndpoints}><span>Fewer</span><span>More</span></div>
      <div className={s.small}>
        Color shows volume, not occupation. Square-root scale: twice as tall = four times the postings. Fixed for the whole timeline
        {p.mode === "fit" ? ` (fitted to ${p.occupationLabel})` : " (shared by all occupations)"}.
      </div>
      <div className={s.keyRow}>
        <span className={s.padSolid} /> <span>0 postings (covered)</span>
      </div>
      <div className={s.keyRow}>
        <span className={s.padRing} /> <span>Unknown: not covered or data gap</span>
      </div>
      <div className={s.keyRow} style={{ marginTop: 8 }}>
        <button type="button" className={s.chip} aria-pressed={p.mode === "fit"} onClick={() => p.onMode(p.mode === "fit" ? "shared" : "fit")}>
          {p.mode === "fit" ? "Fitted scale" : "Fit scale to occupation"}
        </button>
      </div>
    </section>
  );
}

export function TimelineBar(p: {
  historyStart: string;
  dataThrough: string;
  day: string;
  window: WindowKey;
  latest: boolean;
  playing: boolean;
  canPlay: boolean;
  playReason: string | null;
  speed: number;
  gaps: { start: string; end: string }[];
  partialDay: boolean;
  onDay: (d: string) => void;
  onPlay: () => void;
  onSpeed: (n: number) => void;
  onLatest: () => void;
}) {
  const total = Math.max(1, dayIndex(p.historyStart, p.dataThrough));
  const idx = dayIndex(p.historyStart, p.day);
  const id = useId();
  return (
    <section className={`${s.panel} ${s.timeline}`} aria-label="Timeline">
      <button
        type="button"
        className={`${s.btn} ${s.play} ${s.btnPrimary}`}
        onClick={p.onPlay}
        disabled={!p.canPlay}
        title={p.canPlay ? undefined : p.playReason ?? undefined}
        aria-label={p.playing ? "Pause" : "Play history"}
      >
        {p.playing ? "❚❚" : "▶"}
      </button>
      <div className={s.timeLabel} id={id} aria-live="polite">
        <span>{windowLabel(p.day, p.window)}</span>
        <small>
          {p.latest ? "latest data" : "history"}
          {p.partialDay ? " · today is not over" : ""} · data through {fmtDay(p.dataThrough)}
          <span className={s.tz}> · days in America/Toronto</span>
        </small>
      </div>
      <div className={s.sliderWrap}>
        {p.gaps.map((g) => (
          <span
            key={g.start}
            className={s.gapMark}
            title={`No data ${g.start} – ${g.end}`}
            style={{
              left: `${(100 * dayIndex(p.historyStart, g.start)) / total}%`,
              width: `${Math.max(0.6, (100 * (dayIndex(g.start, g.end) + 1)) / total)}%`,
            }}
          />
        ))}
        <input
          className={s.slider}
          type="range"
          min={0}
          max={total}
          step={1}
          value={idx}
          aria-labelledby={id}
          aria-valuetext={fmtDay(p.day)}
          onChange={(e) => p.onDay(addDays(p.historyStart, Number(e.target.value)))}
        />
      </div>
      <div className={s.right}>
        <label className={s.visuallyHidden} htmlFor={`${id}-speed`}>
          Playback speed
        </label>
        <select id={`${id}-speed`} className={s.speed} value={p.speed} onChange={(e) => p.onSpeed(Number(e.target.value))}>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
        </select>
        <button type="button" className={s.btn} onClick={p.onLatest} disabled={p.latest}>
          Latest
        </button>
      </div>
    </section>
  );
}

export function dayIndex(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

export function Sparkline({ series }: { series: SeriesResponse | undefined }) {
  const pts = series?.points ?? [];
  const vals = pts.map((p) => p.count ?? 0);
  const max = Math.max(1, ...vals);
  const w = 260;
  const h = 50;
  const step = pts.length > 1 ? w / (pts.length - 1) : w;
  const path = pts
    .map((p, i) => (p.count == null ? null : `${i * step},${h - 4 - ((p.count ?? 0) / max) * (h - 10)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <svg className={s.spark} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Trend over ${pts.length} days, peak ${max}`}>
      <polyline points={path} fill="none" stroke="#26284a" strokeWidth={2.5} strokeLinejoin="round" />
      {pts.map((p, i) =>
        p.count == null ? <rect key={i} x={i * step - 1} y={0} width={2} height={h} fill="#ff6b5b" opacity={0.25} /> : null,
      )}
    </svg>
  );
}

export function CityCard(p: {
  city: City;
  count: number | null | undefined;
  quality: string;
  day: string;
  window: WindowKey;
  occupationLabel: string;
  series: SeriesResponse | undefined;
  onClose: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), [p.city.city_id]);
  return (
    <section className={`${s.panel} ${s.card}`} aria-label={`${p.city.name} details`}>
      <button ref={ref} type="button" className={`${s.btn} ${s.cardClose}`} onClick={p.onClose} aria-label="Close city details">
        ✕
      </button>
      <h2>
        {p.city.name}, {p.city.province}
      </h2>
      <div className={s.bigCount}>{p.count == null ? "—" : fmtNum(p.count)}</div>
      <div className={s.small}>
        {p.occupationLabel} postings first published {windowLabel(p.day, p.window)}.<br />
        Coverage: {qualityText(p.quality)}
      </div>
      <Sparkline series={p.series} />
      <div className={s.small}>Last 90 days, each point = its own {p.window} window.</div>
    </section>
  );
}

export function qualityText(q: string): string {
  return (
    {
      complete: "complete within Job Bank data",
      partial: "partial window (history starts later or the day is not over)",
      missing: "data gap — unknown, not zero",
      not_covered: "not covered — unknown, not zero",
      stale: "stale",
    } as Record<string, string>
  )[q] ?? q;
}

export function RankingList(p: {
  cities: City[];
  counts: Map<string, number | null>;
  selected: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const rows = p.cities
    .map((c) => ({ c, n: p.counts.get(c.city_id) }))
    .filter((r) => r.n != null && r.n > 0)
    .sort((a, b) => (b.n ?? 0) - (a.n ?? 0) || a.c.name.localeCompare(b.c.name));
  return (
    <section className={`${s.panel} ${s.list}`} aria-label="Cities ranked by postings">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Cities ({rows.length})</h2>
        <button type="button" className={s.btn} onClick={p.onClose} aria-label="Close city list">
          ✕
        </button>
      </div>
      <ol>
        {rows.slice(0, 300).map(({ c, n }) => (
          <li key={c.city_id}>
            <button type="button" aria-current={p.selected === c.city_id} onClick={() => p.onSelect(c.city_id)}>
              <span>
                {c.name}, {c.province}
              </span>
              <strong>{fmtNum(n ?? 0)}</strong>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function SourcesDialog(p: { sources: SourcesResponse | undefined; caps: Capabilities | undefined; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);
  return (
    <div className={s.dialogBackdrop} onClick={p.onClose}>
      <div className={`${s.panel} ${s.dialog}`} role="dialog" aria-modal="true" aria-label="Data sources and definitions" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <h2>Data sources &amp; definitions</h2>
          <button ref={ref} type="button" className={s.btn} onClick={p.onClose}>
            Close
          </button>
        </div>
        {p.caps && (
          <p>
            Mode: <strong>{p.caps.data_mode}</strong> · release {p.caps.release_id ?? "—"} · history {p.caps.history_start ?? "—"} →{" "}
            {p.caps.data_through ?? "—"} · {p.caps.publication}
          </p>
        )}
        <dl>
          {Object.entries(p.sources?.definitions ?? {}).map(([k, v]) => (
            <div key={k}>
              <dt>{k.replace(/_/g, " ")}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <h2 style={{ marginTop: 14 }}>Sources</h2>
        <ul style={{ paddingLeft: 18 }}>
          {p.sources?.sources.map((src) => (
            <li key={src.key}>
              <strong>{src.provider}</strong> <span className={s.status}>{src.admitted ? "used" : src.status}</span>
              <br />
              <span className={s.small}>{src.reason}</span>
              {src.terms_url && (
                <>
                  {" "}
                  ·{" "}
                  <a href={src.terms_url} target="_blank" rel="noreferrer noopener">
                    terms
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
        <h2>Attribution</h2>
        {p.sources?.attributions.map((a) => (
          <p key={a} className={s.small} style={{ margin: "2px 0" }}>
            {a}
          </p>
        ))}
      </div>
    </div>
  );
}
