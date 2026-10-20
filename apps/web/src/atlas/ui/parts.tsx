/** Atlas controls and on-demand panels. English UI; city names keep their own spelling.
 * Defaults stay minimal (brand, occupation, timeline, map icons); everything else opens
 * from "More" or from the date and city notes. */
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";

import { type Capabilities, type City, type Dataset, DATASET_NAME, type Gap, type SeriesResponse, type SourcesResponse, type WindowKey } from "../api";
import { useQuery } from "@tanstack/react-query";
import { atlasGet, type FrameResponse } from "../api";
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

export function Brand(p: {
  caps: Capabilities | undefined;
  occupation: string;
  dataset: Dataset;
  day: string | null;
  window: WindowKey;
  demo: boolean;
  onOccupation: (id: string) => void;
  /** the dataset switch, always visible next to the brand */
  switcher?: ReactNode;
}) {
  const occs = p.caps?.occupations ?? [{ id: "all", label: "All jobs", note: "" }];
  const [open, setOpen] = useState(false);
  const [rankingDay, setRankingDay] = useState<string | null>(null);
  const ranking = useQuery({
    queryKey: ["occupation-ranking", p.dataset, p.caps?.release_id, p.window, rankingDay],
    enabled: open && !!rankingDay && !!p.caps?.release_id,
    staleTime: 300_000,
    queryFn: async ({ signal }) => new Map(await Promise.all(occs.filter(o => o.id !== "all").map(async o => {
      const frame = await atlasGet<FrameResponse>("/frame", { dataset: p.dataset, release: p.caps!.release_id!, occupation: o.id, window: p.window, date: rankingDay! }, signal);
      return [o.id, frame.national.total_unique] as const;
    }))),
  });
  const ranked = [...occs].sort((a, b) => a.id === "all" ? -1 : b.id === "all" ? 1 : (ranking.data?.get(b.id) ?? -1) - (ranking.data?.get(a.id) ?? -1));
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
      {p.switcher}
      <div className={s.occ}>
        <button
          ref={btn}
          type="button"
          className={s.occBtn}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Occupation: ${current.label}`}
          onClick={() => { if (!open) setRankingDay(p.day); setOpen((v) => !v); }}
        >
          {current.label}
          <Icon name="chevron" />
        </button>
        {open && (
          <div ref={menu} className={`${s.popover} ${s.menu} ${s.occupationMenu}`} role="menu" aria-label="Occupation" onKeyDown={menuKeys}>
            <div className={s.rankingNote} role="status">{ranking.isError ? "Ranking unavailable" : !ranking.data ? "Loading posting counts…" : `Most postings · ${rankingDay ? fmtDay(rankingDay) : "current window"}`}</div>
            {ranked.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitemradio"
                aria-checked={o.id === p.occupation}
                aria-label={o.label}
                title={o.note || undefined}
                onClick={() => {
                  p.onOccupation(o.id);
                  setOpen(false);
                  btn.current?.focus();
                }}
              >
                <span>{o.label}</span>
                {o.id !== "all" && <small className={s.occupationCount}>{ranking.data?.get(o.id) == null ? "—" : fmtNum(ranking.data.get(o.id)!)}</small>}
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

/** Job Bank or Employer boards: two parallel datasets, one at a time. Every number and date in
 * the notes comes from each dataset's capabilities. */
export function DatasetSwitch(p: {
  value: Dataset;
  caps: Record<"real" | "ats", Capabilities | undefined>;
  onChange: (d: "real" | "ats") => void;
}) {
  const ids = ["real", "ats"] as const;
  const noteId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const available = (id: "real" | "ats") => !!p.caps[id]?.history_start && p.caps[id]?.data_mode !== "not_configured";
  const note = (id: "real" | "ats") => {
    const c = p.caps[id];
    if (!c) return "Loading…";
    if (!available(id)) return "Not available yet";
    const since = `since ${fmtDay(c.history_start!)}`;
    if (id === "real") return `All occupations · ${c.refresh} · ${since}`;
    const who = c.employers == null ? "Employers'" : `${fmtNum(c.employers)} employers'`;
    return `${who} career pages · updated ${c.refresh} · ${since}`;
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const to = { ArrowLeft: i - 1, ArrowUp: i - 1, ArrowRight: i + 1, ArrowDown: i + 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const id = ids[(to + ids.length) % ids.length]!;
    if (!available(id)) return;
    refs.current[ids.indexOf(id)]?.focus();
    p.onChange(id);
  };
  const current = p.value === "ats" ? "ats" : "real";
  return (
    <div className={s.datasets}>
      <div className={s.datasetGroup} role="radiogroup" aria-label="Dataset">
        {ids.map((id, i) => (
          <button
            key={id}
            ref={(el) => void (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={current === id}
            aria-describedby={`${noteId}-${id}`}
            title={note(id)}
            tabIndex={current === id ? 0 : -1}
            disabled={!available(id) && current !== id}
            onClick={() => current !== id && p.onChange(id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {DATASET_NAME[id]}
            {/* the note stays short of the map: a tooltip, and read with the option */}
            <span id={`${noteId}-${id}`} className={s.visuallyHidden}>{note(id)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const LOWER_BOUND =
  "Includes backfilled days, counted only from postings still open when collection started: the real number is at least this.";

/** "≈ lower bound" next to a number that includes backfilled days. */
export function LowerBound() {
  const id = useId();
  return (
    <>
      <span className={s.lowerBound} title={LOWER_BOUND} aria-describedby={id}>
        ≈ lower bound
      </span>
      <span id={id} className={s.visuallyHidden}>{LOWER_BOUND}</span>
    </>
  );
}

/** What a dataset covers, from its capabilities (Job Bank keeps its existing wording). */
export function coverageText(caps: Capabilities | undefined): string {
  if (caps?.data_mode === "demo") return "Generated demo data";
  if (caps?.dataset_id && caps.refresh === "hourly")
    return `Postings from ${caps.employers == null ? "employers'" : `${fmtNum(caps.employers)} employers'`} own career pages — mostly tech and corporate. Not the whole job market.`;
  return "Source: Job Bank open data (monthly)";
}

/** The map corner's source line: the dataset's attribution and, for hourly data, its age. */
/** Reference data named in the source line when /sources attributes it. */
const REFERENCE_SOURCES: [string, RegExp][] = [["Statistics Canada", /Statistics Canada/], ["GeoNames", /GeoNames/], ["Natural Earth", /Natural Earth/]];

export function SourceLine(p: {
  dataset: Dataset;
  caps: Capabilities | undefined;
  sources: SourcesResponse | undefined;
  publishedAt: string | null | undefined;
  onOpen: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const hourly = p.caps?.refresh === "hourly";
  useEffect(() => {
    if (!hourly) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [hourly]);
  if (!p.caps || p.caps.data_mode === "not_configured") return null;
  const minutes = p.publishedAt ? Math.max(0, Math.round((now - Date.parse(p.publishedAt)) / 60_000)) : null;
  const age = minutes == null ? null : minutes < 60 ? `Updated ${minutes} min ago` : `Updated ${Math.round(minutes / 60)} h ago`;
  // one short line off the map: the shown dataset's source (Employer boards: its platforms),
  // then the reference data /sources attributes; the full attributions are in the dialog
  const own = p.dataset === "ats" && p.caps.platforms.length ? p.caps.platforms : [DATASET_NAME[p.dataset]];
  const all = p.sources?.attributions ?? [];
  const names = [...own, ...REFERENCE_SOURCES.filter(([, re]) => all.some((a) => re.test(a))).map(([name]) => name)];
  return (
    <p className={s.sourceLine}>
      <button type="button" className={s.sourceBtn} onClick={p.onOpen} aria-haspopup="dialog">
        Sources: {names.join(" · ")}
      </button>
      {hourly && age && <> · {age}</>}
    </p>
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
  national: { total_unique: number | null; city_unconfirmed: number | null; remote_canada: number | null } | undefined;
  /** the national total includes backfilled days (a lower bound) */
  lowerBound: boolean;
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
          {coverageText(p.caps)}
          {p.publishedAt && !demo && <> · updated {new Date(p.publishedAt).toLocaleDateString("en-CA")}</>}
          {p.caps.attribution && <><br />{p.caps.attribution}</>}
          {p.national && (
            <>
              <br />
              Canada: <strong>{p.national.total_unique == null ? "unknown" : fmtNum(p.national.total_unique)}</strong> postings
              {p.lowerBound && p.national.total_unique != null && <> <LowerBound /></>}
              {(p.national.remote_canada ?? 0) + (p.national.city_unconfirmed ?? 0) > 0 && (
                <>
                  <br />
                  On the map: cities only · + {fmtNum((p.national.remote_canada ?? 0) + (p.national.city_unconfirmed ?? 0))} remote or city unconfirmed
                </>
              )}
            </>
          )}
        </p>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- timeline

export function TimelineBar(p: {
  overview?: boolean;
  playLabel?: string;
  playbackOptions?: ReactNode;
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
  /** days counted only from postings still open when collection started */
  backfilled: Gap[];
  partialDay: boolean;
  /** briefly highlight the date (it jumped, e.g. to another dataset's latest day) */
  flash: boolean;
  /** a quiet "Latest" link while viewing history (hourly data has no "new data" banner) */
  latestLink: boolean;
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
      <div className={s.playbackGroup}>
      <button
        type="button"
        className={`${s.iconBtn} ${s.play}`}
        onClick={p.onPlay}
        disabled={!p.canPlay}
        title={p.canPlay ? p.playLabel : p.playReason ?? undefined}
        aria-label={p.playLabel ?? (p.playing ? "Pause" : p.overview ? "Continue overview" : "Play history")}
      >
        <Icon name={p.playing ? "pause" : "play"} />
      </button>
      {p.playbackOptions}
      </div>
      <div className={s.when}>
        <button ref={btn} type="button" className={`${s.dateBtn} ${p.flash ? s.dateFlash : ""}`} id={id} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span>{fmtDay(p.day)}</span>
          <small>New postings · Past {p.window === "1d" ? "1 day" : p.window === "7d" ? "7 days" : "30 days"}</small>
        </button>
        {p.latestLink && !p.latest && (
          <button type="button" className={s.latestLink} onClick={p.onLatest}>
            Latest
          </button>
        )}
        {open && (
          <div ref={box} className={`${s.popover} ${s.timePopover}`} role="dialog" aria-label="Time settings">
            <p className={s.small}>{label}</p>
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
              {!p.overview && <label>
                Daily exploration speed{" "}
                <select className={s.speed} value={p.speed} onChange={(e) => p.onSpeed(Number(e.target.value))}>
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </label>}
            </div>
            <p className={s.small}>
              {p.latest ? "Latest data" : "History"}
              {p.partialDay ? " · today is not over" : ""} · data through {fmtDay(p.dataThrough)} · days in America/Toronto
            </p>
          </div>
        )}
      </div>
      <div className={s.sliderWrap}>
        {p.backfilled.map((g) => (
          <span
            key={`b${g.start}`}
            className={s.backfillMark}
            tabIndex={0}
            role="note"
            aria-label={`${g.start} – ${g.end}: ${BACKFILLED}`}
            data-tip={BACKFILLED}
            style={{
              left: `${(100 * dayIndex(p.historyStart, g.start)) / total}%`,
              width: `${Math.max(0.6, (100 * (dayIndex(g.start, g.end) + 1)) / total)}%`,
            }}
          />
        ))}
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

const BACKFILLED = "Backfilled from postings still open when collection started — lower bounds";

function dayIndex(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------- city

function Sparkline({ series }: { series: SeriesResponse | undefined }) {
  const pts = series?.points ?? [];
  const vals = pts.map((p) => p.count ?? 0);
  const max = Math.max(1, ...vals);
  const w = 260;
  const h = 50;
  const step = pts.length > 1 ? w / (pts.length - 1) : w;
  const y = (c: number) => h - 4 - (c / max) * (h - 10);
  // one segment per day; a day that includes backfilled days (a lower bound) is dashed
  const segments = pts.slice(1).map((p, i) => {
    const a = pts[i]!;
    if (a.count == null || p.count == null) return null;
    const dashed = a.backfilled_days > 0 || p.backfilled_days > 0;
    return <line key={i} x1={i * step} y1={y(a.count)} x2={(i + 1) * step} y2={y(p.count)} strokeDasharray={dashed ? "3 3" : undefined} />;
  });
  const lower = pts.some((p) => p.backfilled_days > 0);
  return (
    <svg className={s.spark} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Trend over ${pts.length} days, peak ${max}${lower ? "; dashed days are lower bounds (backfilled)" : ""}`}>
      <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">{segments}</g>
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
  dataset: Dataset;
  lowerBound: boolean;
  onClose: () => void;
}) {
  return (
    <Panel label={`${p.city.name} details`} className={s.card} onClose={p.onClose} autoFocusClose>
      <h2>
        {p.city.name}, {p.city.province}
      </h2>
      <div className={s.bigCount}>
        {p.count == null ? "—" : `${fmtNum(p.count)} jobs`}
        {p.lowerBound && p.count != null && <> <LowerBound /></>}
      </div>
      <p className={s.small}>
        {p.occupationLabel} postings first published {windowLabel(p.day, p.window)}.<br />
        Coverage: {qualityText(p.quality, DATASET_NAME[p.dataset])}
      </p>
      <Sparkline series={p.series} />
      <p className={s.small}>Last 90 days, each point = its own {p.window} window.</p>
    </Panel>
  );
}

function qualityText(q: string, dataset: string): string {
  return (
    {
      complete: `complete within ${dataset} data`,
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
        {p.caps?.attribution && <p className={s.small}>{p.caps.attribution}</p>}
        {p.caps?.refresh === "hourly" && <p className={s.small}>{coverageText(p.caps)}</p>}
        {p.sources?.attributions.filter((a) => a !== p.caps?.attribution).map((a) => (
          <p key={a} className={s.small}>
            {a}
          </p>
        ))}
      </div>
    </div>
  );
}
