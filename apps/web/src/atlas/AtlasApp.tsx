/** JobAtlas v2: Canada job-postings diorama (docs/JOBATLAS_V2_DEVELOPMENT_SPEC.zh-CN.md).
 * One selection (URL-backed); data bound to one release; playback steps one real day at a
 * time and stops at gaps and at the end; demo data is labelled everywhere it is shown. */
import "@fontsource/dela-gothic-one/400.css";
import "@fontsource/m-plus-rounded-1c/500.css";
import "@fontsource/m-plus-rounded-1c/700.css";
import "@fontsource/m-plus-rounded-1c/800.css";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { atlasGet, type FrameResponse, type WindowKey } from "./api";
import { type GeoData, webglAvailable } from "./scene/AtlasScene";
import { DIORAMA, PANEL } from "./scene/palette";
import { addDays, DEFAULT_SELECTION, parseSelection, type Selection, serializeSelection } from "./state";
import s from "./ui/atlas.module.css";
import { FallbackMap } from "./ui/FallbackMap";
import { CityCard, fmtDay, fmtNum, Legend, OCC_SHORT, RankingList, SourcesDialog, TimelineBar, TopBar } from "./ui/parts";
import { SceneView } from "./ui/SceneView";
import {
  useCapabilities,
  useCities,
  useLatestVersion,
  useScaleMax,
  useSeries,
  useSources,
  useTimelineChunk,
} from "./useAtlasData";

const STEP_MS = 650;
const WINDOW_DAYS: Record<WindowKey, number> = { "1d": 1, "7d": 7, "30d": 30 };

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia?.(query);
      m?.addEventListener("change", cb);
      return () => m?.removeEventListener("change", cb);
    },
    () => window.matchMedia?.(query).matches ?? false,
  );
}

export function AtlasApp() {
  const qc = useQueryClient();
  const [sel, setSelState] = useState<Selection>(() => parseSelection(window.location.search));
  const set = useCallback((patch: Partial<Selection>) => setSelState((cur) => ({ ...cur, ...patch })), []);
  useEffect(() => {
    const keep = new URLSearchParams(window.location.search).get("draft");
    const q = serializeSelection(sel);
    const extra = keep ? `${q ? "&" : "?"}draft=${keep}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${q}${extra}`);
  }, [sel]);

  const palette = useMemo(() => (new URLSearchParams(window.location.search).get("draft") === "b" ? PANEL : DIORAMA), []);
  const reducedMotion = useMedia("(prefers-reduced-motion: reduce)");
  const webgl = useMemo(() => webglAvailable(), []);
  const [listOpen, setListOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [toast, setToast] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const caps = useCapabilities(sel.dataset);
  const info = caps.data;
  const release = info?.release_id ?? null;
  const ready = !!info && info.data_mode !== "not_configured" && !!info.history_start && !!info.data_through;
  const historyStart = info?.history_start ?? null;
  const dataThrough = info?.data_through ?? null;
  const day = clampDay(sel.date ?? dataThrough, historyStart, dataThrough);
  const latest = !!day && day === dataThrough;

  const geo = useQuery({
    queryKey: ["atlas", "geo"],
    queryFn: async () => (await (await fetch("/atlas/canada-geo.json")).json()) as GeoData,
    staleTime: Infinity,
  });
  const cities = useCities(sel.dataset, release);
  const args = { dataset: sel.dataset, release, occupation: sel.occupation, window: sel.window, historyStart, dataThrough };
  const tl = useTimelineChunk(args, day, playing);
  const scaleMax = useScaleMax(args, sel.scale);
  const sources = useSources();

  // Counts for the shown day. While a new chunk loads, the previous counts stay on screen
  // (never a flash of zeros); the key changes only when real data for `day` is present.
  const frame = tl.data?.frames.find((f) => f.date === day);
  const lastGood = useRef<{ key: string; counts: Map<string, number | null> }>({ key: "", counts: new Map() });
  const sameSelection = tl.data && tl.data.occupation === sel.occupation && tl.data.window === sel.window && tl.data.release_id === release;
  if (frame && sameSelection) {
    const key = `${release}|${sel.occupation}|${sel.window}|${day}`;
    if (key !== lastGood.current.key) {
      const m = new Map<string, number | null>();
      tl.data!.city_ids.forEach((id, i) => m.set(id, frame.counts[i] ?? null));
      lastGood.current = { key, counts: m };
    }
  }
  const counts = lastGood.current.counts;

  // National summary (latest/paused only, from the frame endpoint).
  const national = useQuery({
    queryKey: ["atlas", "frame", sel.dataset, release, sel.occupation, sel.window, day],
    queryFn: ({ signal }) =>
      atlasGet<FrameResponse>("/frame", { dataset: sel.dataset, release: release ?? undefined, occupation: sel.occupation, window: sel.window, date: day ?? undefined }, signal),
    enabled: ready && !playing && !!day,
    staleTime: Infinity,
  });

  // ---------------------------------------------------------------- playback
  const gaps = info?.gaps ?? [];
  const inGap = (d: string) => gaps.some((g) => d >= g.start && d <= g.end);
  useEffect(() => {
    if (!playing || !day || !dataThrough) return;
    if (!frame) return; // wait for the real frame before moving on
    if (day >= dataThrough) {
      setPlaying(false); // stay at the end; no loop
      return;
    }
    const next = addDays(day, 1);
    const t = setTimeout(() => {
      if (inGap(next)) {
        setPlaying(false);
        set({ date: next });
        setToast(`Stopped at a data gap (${gapAt(next)?.start} – ${gapAt(next)?.end}). Unknown days are not drawn as zero.`);
        return;
      }
      set({ date: next });
    }, STEP_MS / speed);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, day, frame, speed, dataThrough]);
  const gapAt = (d: string) => gaps.find((g) => d >= g.start && d <= g.end);

  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (!historyStart || !dataThrough) return;
    // From the end, replay from the start of the history.
    if (latest) set({ date: historyStart });
    setPlaying(true);
  };

  // ---------------------------------------------------------------- new versions
  const version = useLatestVersion(sel.dataset);
  const newer = !!version.data?.release_id && !!release && version.data.release_id !== release && version.data.data_mode !== "not_configured";
  useEffect(() => {
    if (!newer || !version.data) return;
    if (sel.date === null) {
      // latest mode: move to the new release; crystals animate only through real changes
      void qc.invalidateQueries({ queryKey: ["atlas", "caps", sel.dataset] });
      setToast(
        version.data.change_kind === "update" && version.data.data_through
          ? `New data through ${fmtDay(version.data.data_through)}`
          : "Data updated (coverage or corrections, not necessarily new postings)",
      );
    }
  }, [newer, version.data, sel.date, sel.dataset, qc]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---------------------------------------------------------------- selection
  const selectedCity = cities.data?.cities.find((c) => c.city_id === sel.city) ?? null;
  const series = useSeries(sel.dataset, release, sel.city, sel.occupation, sel.window, day);
  const occLabel = OCC_SHORT[sel.occupation] ?? sel.occupation;
  const countsKey = lastGood.current.key;
  const onSelect = useCallback((id: string | null) => set({ city: id }), [set]);

  // ---------------------------------------------------------------- render
  const demo = info?.data_mode === "demo";
  const status = frame?.quality;
  return (
    <div className={s.app}>
      {geo.data && cities.data && ready && scaleMax != null ? (
        webgl ? (
          <SceneView
            geo={geo.data}
            cities={cities.data.cities}
            counts={counts}
            countsKey={countsKey}
            scaleMax={scaleMax}
            palette={palette}
            reducedMotion={reducedMotion}
            selected={sel.city}
            focus={focus}
            onSelect={onSelect}
          />
        ) : (
          <FallbackMap geo={geo.data} cities={cities.data.cities} counts={counts} scaleMax={scaleMax} onSelect={(id) => set({ city: id })} />
        )
      ) : null}

      {demo && (
        <div className={s.watermark} aria-hidden="true">
          <span>DEMO DATA · 示例数据</span>
        </div>
      )}

      <TopBar
        caps={info}
        occupation={sel.occupation}
        window={sel.window}
        demo={demo}
        onOccupation={(occupation) => set({ occupation })}
        onWindow={(w: WindowKey) => set({ window: w })}
      />

      <aside className={s.corner}>
        <div className={`${s.panel} ${s.meta}`} role="status">
          {ready ? (
            <>
              Data through <strong>{fmtDay(dataThrough!)}</strong>
              {info?.stale && <> · <strong>may be stale</strong></>}
              <br />
              {demo ? "Generated demo data" : "Source: Job Bank open data (monthly)"}
              {version.data?.published_at && !demo && <> · updated {new Date(version.data.published_at).toLocaleDateString("en-CA")}</>}
              {national.data && (
                <>
                  <br />
                  Canada: <strong>{national.data.national.total_unique == null ? "unknown" : fmtNum(national.data.national.total_unique)}</strong> postings
                  {national.data.national.city_unconfirmed ? <> · {fmtNum(national.data.national.city_unconfirmed)} city unconfirmed</> : null}
                </>
              )}
            </>
          ) : (
            "JobAtlas"
          )}
        </div>
        <div className={s.row}>
          <button type="button" className={s.btn} onClick={() => setListOpen((v) => !v)} aria-expanded={listOpen} disabled={!ready}>
            City list
          </button>
          <button type="button" className={s.btn} onClick={() => setSourcesOpen(true)}>
            Sources &amp; definitions
          </button>
        </div>
        {ready && <Legend scaleMax={scaleMax} mode={sel.scale} occupationLabel={occLabel} onMode={(scale) => set({ scale })} />}
      </aside>

      {ready && day && (
        <TimelineBar
          historyStart={historyStart!}
          dataThrough={dataThrough!}
          day={day}
          window={sel.window}
          latest={latest}
          playing={playing}
          canPlay={!!info?.playback}
          playReason={info?.playback_reason ?? null}
          speed={speed}
          gaps={gaps}
          partialDay={latest && !!info?.partial_latest_day}
          onDay={(d) => {
            setPlaying(false);
            set({ date: d === dataThrough ? null : d });
          }}
          onPlay={togglePlay}
          onSpeed={setSpeed}
          onLatest={() => {
            setPlaying(false);
            set({ date: null });
          }}
        />
      )}

      {selectedCity && day && (
        <CityCard
          city={selectedCity}
          count={counts.get(selectedCity.city_id)}
          quality={counts.get(selectedCity.city_id) == null && status !== "missing" ? "not_covered" : status ?? "complete"}
          day={day}
          window={sel.window}
          occupationLabel={occLabel}
          series={series.data}
          onClose={() => set({ city: null })}
        />
      )}
      {listOpen && cities.data && (
        <RankingList
          cities={cities.data.cities}
          counts={counts}
          selected={sel.city}
          onSelect={(id) => {
            set({ city: id });
            setFocus(id);
          }}
          onClose={() => setListOpen(false)}
        />
      )}

      {/* notices: gap, partial window, history behind a newer release, update toast */}
      {ready && status === "missing" && (
        <div className={`${s.panel} ${s.notice}`} role="status">
          No data for this window ({gapTouching(day!, gaps, WINDOW_DAYS[sel.window])}). Unknown, not zero.
          <button type="button" className={s.btn} onClick={() => set({ date: skipGap(day!, gaps, dataThrough!, WINDOW_DAYS[sel.window]) })}>
            Skip to next available
          </button>
        </div>
      )}
      {ready && status === "partial" && !toast && frame && (
        <div className={`${s.panel} ${s.notice}`} role="status">
          {frame.days_available < WINDOW_DAYS[sel.window]
            ? `Partial window: only ${frame.days_available} of ${WINDOW_DAYS[sel.window]} days have data (history starts ${fmtDay(historyStart!)}).`
            : frame.notes.join(" · ")}
        </div>
      )}
      {newer && sel.date !== null && (
        <div className={`${s.panel} ${s.notice}`} role="status">
          New data available.
          <button type="button" className={s.btn} onClick={() => set({ date: null })}>
            Go to latest
          </button>
        </div>
      )}
      {toast && (
        <div className={`${s.panel} ${s.notice} ${s.toast}`} role="status">
          {toast}
        </div>
      )}

      {/* blocking states */}
      {caps.isPending && <Banner title="Loading the map…" />}
      {caps.isError && (
        <Banner title="Could not reach the data service">
          <button type="button" className={s.btn} onClick={() => caps.refetch()}>
            Retry
          </button>
        </Banner>
      )}
      {info?.data_mode === "not_configured" && (
        <Banner title={sel.dataset === "demo" ? "Demo data unavailable" : "Data source not connected yet"}>
          <p className={s.small}>{info.reason}</p>
          {sel.dataset === "real" && (
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => set({ ...DEFAULT_SELECTION, dataset: "demo" })}>
              View demo data (clearly labelled)
            </button>
          )}
        </Banner>
      )}
      {ready && (tl.isError || cities.isError) && (
        <Banner title="Data could not be loaded">
          <button type="button" className={s.btn} onClick={() => void qc.invalidateQueries({ queryKey: ["atlas"] })}>
            Retry
          </button>
        </Banner>
      )}
      {sourcesOpen && <SourcesDialog sources={sources.data} caps={info} onClose={() => setSourcesOpen(false)} />}
    </div>
  );
}

function Banner({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className={`${s.panel} ${s.banner}`} role="alert">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function clampDay(d: string | null, start: string | null, end: string | null): string | null {
  if (!d || !start || !end) return d;
  return d < start ? start : d > end ? end : d;
}

/** First day whose whole window is past the gap that the current window touches. */
function skipGap(day: string, gaps: { start: string; end: string }[], end: string, windowDays: number): string | null {
  const first = addDays(day, -(windowDays - 1));
  const g = gaps.find((x) => x.start <= day && x.end >= first);
  if (!g) return day;
  const next = addDays(g.end, windowDays);
  return next >= end ? null : next;
}

function gapTouching(day: string, gaps: { start: string; end: string }[], windowDays: number): string {
  const first = addDays(day, -(windowDays - 1));
  const g = gaps.find((x) => x.start <= day && x.end >= first);
  return g ? `gap ${g.start} – ${g.end}` : "gap";
}
