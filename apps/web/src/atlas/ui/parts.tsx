/** Atlas controls and on-demand panels. English UI; city names keep their own spelling.
 * Defaults stay minimal (brand, occupation, timeline, map icons); everything else opens
 * from "More" or from the date and city notes. */
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";

import type { Capabilities, City, SeriesResponse, SourcesResponse, WindowKey } from "../api";
import { legendTicks } from "../scale";
import { addDays } from "../state";
import s from "./atlas.module.css";

const fmtDate = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtShort = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
const utc = (iso: string) => new Date(`${iso}T12:00:00Z`);
export const fmtDay = (iso: string) => fmtDate.format(utc(iso));
export const fmtNum = (n: number) => n.toLocaleString("en-CA");
const WINDOW_DAYS: Record<WindowKey, number> = { "1d": 1, "7d": 7, "30d": 30 };

/** The counted range, compact: "Sep 24–30, 2026", "Aug 31 – Sep 6, 2026", "Sep 30, 2026". */
export function windowLabel(day: string, w: WindowKey): string {
  if (w === "1d") return fmtDay(day);
  const first = addDays(day, -(WINDOW_DAYS[w] - 1));
  if (first.slice(0, 4) !== day.slice(0, 4)) return `${fmtDay(first)} – ${fmtDay(day)}`;
  if (first.slice(0, 7) === day.slice(0, 7)) return `${fmtShort.format(utc(first))}–${Number(day.slice(8))}, ${day.slice(0, 4)}`;
  return `${fmtShort.format(utc(first))} – ${fmtDay(day)}`;
}

// ---------------------------------------------------------------- icons

const ICONS: Record<string, ReactNode> = {
  play: <path d="M7.5 5.5v9l7-4.5z" fill="currentColor" stroke="none" />,
  pause: <path d="M7.5 5.5v9M12.5 5.5v9" strokeWidth={2} />,
  // reset = fit the view (frame corners), distinct from the turning arrows
  reset: <><path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" /><circle cx="10" cy="10" r="1.6" /></>,
  rotateLeft: <path d="M4.5 10a5.5 5.5 0 1 0 1.8-4.1M6 2.8l.1 3.4 3.4-.1" />,
  rotateRight: <path d="M15.5 10a5.5 5.5 0 1 1-1.8-4.1M14 2.8l-.1 3.4-3.4-.1" />,
  plus: <><circle cx="10" cy="10" r="8.4" /><path d="M10 6.2v7.6M6.2 10h7.6" /></>,
  minus: <><circle cx="10" cy="10" r="8.4" /><path d="M6.2 10h7.6" /></>,
  more: <><circle cx="4.5" cy="10" r="1.1" fill="currentColor" /><circle cx="10" cy="10" r="1.1" fill="currentColor" /><circle cx="15.5" cy="10" r="1.1" fill="currentColor" /></>,
  chevron: <path d="M6 8l4 4 4-4" />,
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
};

export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className={s.icon} viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

/** Closes a popup on Escape (focus back to its opener) and on a press outside it. */
function useDismiss(open: boolean, box: RefObject<HTMLElement | null>, opener: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
      opener.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !opener.current?.contains(t)) close();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, box, opener, close]);
}

/** Arrow keys move between the items of a menu. */
function menuKeys(e: React.KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role^=menuitem]")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  items[(to + items.length) % items.length]?.focus();
}

// ---------------------------------------------------------------- top left

export function Brand(p: { caps: Capabilities | undefined; occupation: string; demo: boolean; onOccupation: (id: string) => void }) {
  const occs = p.caps?.occupations ?? [{ id: "all", label: "All jobs", note: "" }];
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, menu, btn, close);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>("[aria-checked=true]")?.focus();
  }, [open]);
  const current = occs.find((o) => o.id === p.occupation) ?? occs[0]!;
  return (
    <header className={s.top}>
      <h1 className={s.brand}>JobAtlas</h1>
      <div className={s.occ}>
        <button
          ref={btn}
          type="button"
          className={s.occBtn}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Occupation: ${current.label}`}
          onClick={() => setOpen((v) => !v)}
        >
          {current.label}
          <Icon name="chevron" />
        </button>
        {open && (
          <div ref={menu} className={`${s.popover} ${s.menu}`} role="menu" aria-label="Occupation" onKeyDown={menuKeys}>
            {occs.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitemradio"
                aria-checked={o.id === p.occupation}
                title={o.note || undefined}
                onClick={() => {
                  p.onOccupation(o.id);
                  setOpen(false);
                  btn.current?.focus();
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {p.demo && (
        <div className={s.badge} role="status">
          Demo data · 示例数据 — generated, not real postings
        </div>
      )}
    </header>
  );
}

// ---------------------------------------------------------------- top right

export type MoreItem = "cities" | "scale" | "sources";

export function MoreMenu(p: { onPick: (item: MoreItem) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, menu, btn, close);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);
  const item = (id: MoreItem, label: string) => (
    <button
      type="button"
      role="menuitem"
      disabled={p.disabled && id !== "sources"}
      onClick={() => {
        setOpen(false);
        p.onPick(id);
      }}
    >
      {label}
    </button>
  );
  return (
    <div className={s.more}>
      <button ref={btn} type="button" className={s.iconBtn} aria-label="More" aria-haspopup="menu" aria-expanded={open} title="More" onClick={() => setOpen((v) => !v)}>
        <Icon name="more" />
      </button>
      {open && (
        <div ref={menu} className={`${s.popover} ${s.menu} ${s.menuRight}`} role="menu" aria-label="More" onKeyDown={menuKeys}>
          {item("cities", "Search cities")}
          {item("scale", "Height scale & data")}
          {item("sources", "Sources & definitions")}
        </div>
      )}
    </div>
  );
}

/** A light non-modal side panel with a title and a close button. */
function Panel(p: { label: string; className: string | undefined; onClose: () => void; children: ReactNode; autoFocusClose?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (p.autoFocusClose) ref.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.label]);
  return (
    <section className={`${s.panel} ${p.className}`} aria-label={p.label}>
      <button ref={ref} type="button" className={`${s.iconBtn} ${s.panelClose}`} onClick={p.onClose} aria-label={`Close ${p.label.toLowerCase()}`}>
        <Icon name="close" />
      </button>
      {p.children}
    </section>
  );
}

export function ScalePanel(p: {
  scaleMax: number | null;
  mode: "shared" | "fit";
  occupationLabel: string;
  onMode: (m: "shared" | "fit") => void;
  caps: Capabilities | undefined;
  publishedAt: string | null | undefined;
  national: { total_unique: number | null; city_unconfirmed: number | null } | undefined;
  onClose: () => void;
}) {
  const ticks = p.scaleMax ? legendTicks(p.scaleMax, 3) : [];
  const max = p.scaleMax ?? 1;
  const demo = p.caps?.data_mode === "demo";
  return (
    <Panel label="Height scale and data" className={s.scalePanel} onClose={p.onClose} autoFocusClose>
      <h2>Height scale</h2>
      <svg className={s.domes} viewBox="0 0 150 64" aria-hidden="true">
        {ticks.map((t, i) => {
          const h = 50 * Math.sqrt(t / max);
          const x = 12 + i * 48;
          return (
            <g key={t}>
              <path d={`M${x} 56 V${56 - h + 6} Q${x} ${56 - h} ${x + 7} ${56 - h} Q${x + 14} ${56 - h} ${x + 14} ${56 - h + 6} V56 Z`} />
              <text x={x + 18} y={56}>{fmtNum(t)}</text>
            </g>
          );
        })}
      </svg>
      <p>
        Height shows new job postings. Square-root scale: twice as tall = four times the postings. Fixed for the whole timeline
        {p.mode === "fit" ? ` (fitted to ${p.occupationLabel})` : " (shared by all occupations)"}.
      </p>
      <div className={s.segment} role="radiogroup" aria-label="Height scale">
        <button type="button" role="radio" aria-checked={p.mode === "shared"} onClick={() => p.onMode("shared")}>
          Shared
        </button>
        <button type="button" role="radio" aria-checked={p.mode === "fit"} onClick={() => p.onMode("fit")}>
          Fit to occupation
        </button>
      </div>
      <ul className={s.key}>
        <li><span className={s.keyDot} /> Postings, city not drawn as a body</li>
        <li><span className={s.keyZero} /> 0 postings (covered)</li>
        <li><span className={s.keyRing} /> Unknown: not covered or data gap</li>
      </ul>
      <p className={s.small}>
        The national overview draws only some cities as bodies; zoom in or search to see the rest.
        <br />
        <span lang="zh">全国概览仅展开部分城市，放大或检索查看其余城市。</span>
      </p>
      {p.caps?.data_through && (
        <p className={s.small}>
          Data through <strong>{fmtDay(p.caps.data_through)}</strong>
          {p.caps.stale && <> · <strong>may be stale</strong></>}
          <br />
          {demo ? "Generated demo data" : "Source: Job Bank open data (monthly)"}
          {p.publishedAt && !demo && <> · updated {new Date(p.publishedAt).toLocaleDateString("en-CA")}</>}
          {p.national && (
            <>
              <br />
              Canada: <strong>{p.national.total_unique == null ? "unknown" : fmtNum(p.national.total_unique)}</strong> postings
              {p.national.city_unconfirmed ? <> · {fmtNum(p.national.city_unconfirmed)} city unconfirmed</> : null}
            </>
          )}
        </p>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- timeline

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
  onWindow: (w: WindowKey) => void;
}) {
  const total = Math.max(1, dayIndex(p.historyStart, p.dataThrough));
  const idx = dayIndex(p.historyStart, p.day);
  const id = useId();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, box, btn, close);
  const label = windowLabel(p.day, p.window);
  return (
    <section className={s.timeline} aria-label="Timeline">
      <button
        type="button"
        className={`${s.iconBtn} ${s.play}`}
        onClick={p.onPlay}
        disabled={!p.canPlay}
        title={p.canPlay ? undefined : p.playReason ?? undefined}
        aria-label={p.playing ? "Pause" : "Play history"}
      >
        <Icon name={p.playing ? "pause" : "play"} />
      </button>
      <div className={s.when}>
        <button ref={btn} type="button" className={s.dateBtn} id={id} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span aria-live="polite">{label}</span>
          {!p.latest && <small>history</small>}
        </button>
        {open && (
          <div ref={box} className={`${s.popover} ${s.timePopover}`} role="dialog" aria-label="Time settings">
            <div className={s.segment} role="radiogroup" aria-label="Time window">
              {(["1d", "7d", "30d"] as WindowKey[]).map((w) => (
                <button key={w} type="button" role="radio" aria-checked={p.window === w} onClick={() => p.onWindow(w)}>
                  {w === "1d" ? "1 day" : w === "7d" ? "7 days" : "30 days"}
                </button>
              ))}
            </div>
            <div className={s.popRow}>
              <button type="button" className={s.textBtn} onClick={p.onLatest} disabled={p.latest}>
                Latest
              </button>
              <label>
                Speed{" "}
                <select className={s.speed} value={p.speed} onChange={(e) => p.onSpeed(Number(e.target.value))}>
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </label>
            </div>
            <p className={s.small}>
              {p.latest ? "Latest data" : "History"}
              {p.partialDay ? " · today is not over" : ""} · data through {fmtDay(p.dataThrough)} · days in America/Toronto
            </p>
          </div>
        )}
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
          aria-label={`Date: ${label}`}
          aria-valuetext={fmtDay(p.day)}
          onChange={(e) => p.onDay(addDays(p.historyStart, Number(e.target.value)))}
        />
      </div>
    </section>
  );
}

export function dayIndex(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------- city

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
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
      {pts.map((p, i) => (p.count == null ? <rect key={i} x={i * step - 1} y={0} width={2} height={h} className={s.sparkGap} /> : null))}
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
  return (
    <Panel label={`${p.city.name} details`} className={s.card} onClose={p.onClose} autoFocusClose>
      <h2>
        {p.city.name}, {p.city.province}
      </h2>
      <div className={s.bigCount}>{p.count == null ? "—" : `${fmtNum(p.count)} jobs`}</div>
      <p className={s.small}>
        {p.occupationLabel} postings first published {windowLabel(p.day, p.window)}.<br />
        Coverage: {qualityText(p.quality)}
      </p>
      <Sparkline series={p.series} />
      <p className={s.small}>Last 90 days, each point = its own {p.window} window.</p>
    </Panel>
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

/** Ranked list of cities with postings; a search reaches every city, including zero and
 * unknown ones (shown as such, never as zero). */
export function RankingList(p: {
  cities: City[];
  counts: Map<string, number | null>;
  selected: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus({ preventScroll: true }), []);
  const q = query.trim().toLowerCase();
  const rows = p.cities
    .map((c) => ({ c, n: p.counts.get(c.city_id) ?? null }))
    .filter((r) => (q ? r.c.name.toLowerCase().includes(q) || r.c.aliases.some((a) => a.toLowerCase().includes(q)) : r.n != null && r.n > 0))
    .sort((a, b) => (b.n ?? -1) - (a.n ?? -1) || a.c.name.localeCompare(b.c.name));
  return (
    <Panel label="City list" className={s.list} onClose={p.onClose}>
      <h2>Cities {q ? "" : `(${rows.length})`}</h2>
      <input
        ref={input}
        className={s.search}
        type="search"
        placeholder="Search cities"
        aria-label="Search cities"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ol>
        {rows.slice(0, 300).map(({ c, n }) => (
          <li key={c.city_id}>
            <button type="button" aria-current={p.selected === c.city_id} onClick={() => p.onSelect(c.city_id)}>
              <span>
                {c.name}, {c.province}
              </span>
              <strong>{n == null ? "unknown" : fmtNum(n)}</strong>
            </button>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export function SourcesDialog(p: { sources: SourcesResponse | undefined; caps: Capabilities | undefined; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const onClose = useRef(p.onClose);
  onClose.current = p.onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, []);
  return (
    <div className={s.dialogBackdrop} onClick={p.onClose}>
      <div className={`${s.panel} ${s.dialog}`} role="dialog" aria-modal="true" aria-label="Data sources and definitions" onClick={(e) => e.stopPropagation()}>
        <button ref={ref} type="button" className={`${s.iconBtn} ${s.panelClose}`} onClick={p.onClose} aria-label="Close">
          <Icon name="close" />
        </button>
        <h2>Data sources &amp; definitions</h2>
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
        <h2>Sources</h2>
        <ul>
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
          <p key={a} className={s.small}>
            {a}
          </p>
        ))}
      </div>
    </div>
  );
}
