import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Icon } from "../components/Icon";
import {
  apiGet,
  type Bbox,
  type GroupName,
  type JobCard,
  type JobDetail,
  type Region,
  type TimeWindow,
  type WorkplaceFilter,
} from "../lib/api";
import { relativeTime } from "../lib/format";
import { t } from "../lib/strings";
import { JobDetailCard } from "../features/jobs/JobDetailCard";
import { ListSheet } from "../features/jobs/ListSheet";
import { ResultsPanel } from "../features/jobs/ResultsPanel";
import { type PickerJob, SameSitePicker } from "../features/jobs/SameSitePicker";
import { jobCoordinates } from "../features/map/locations";
import { type FlyTarget, type MapSelection, MapView } from "../features/map/MapView";
import { DEFAULT_TIME_WINDOW, type DockPopover, SearchDock } from "../features/search/SearchDock";
import { useCoverage, useGroupPages, useJobSearch } from "../features/search/useSearch";
import styles from "./App.module.css";

/** Initial view: central GTA. The remote-eligibility region starts as the whole GTA. */
export const INITIAL_BBOX: Bbox = [-79.64, 43.58, -79.11, 43.86];
const GTA: Region = {
  region_id: "gta",
  name: "GTA",
  parent_id: "ca-on",
  kind: "metro",
  bbox: [-80.25, 43.25, -78.6, 44.6],
  approximate: true,
  dataset_version: null,
};
const GROUPS: GroupName[] = ["in_view", "remote_elsewhere", "location_unverified"];

/** At most one content overlay at a time: filters, area, the list, one job, or one address. */
type Overlay =
  | { kind: DockPopover }
  | { kind: "list" }
  | { kind: "detail"; jobId: string; at: [number, number] | null; workplace: string; fromList: boolean; filterKey: string }
  | { kind: "site"; jobIds: string[]; at: [number, number] };

const PHONE = "(max-width: 760px)";
function useIsPhone() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia?.(PHONE);
      m?.addEventListener("change", cb);
      return () => m?.removeEventListener("change", cb);
    },
    () => window.matchMedia?.(PHONE).matches ?? false,
  );
}

function inside(b: Bbox | undefined, [lon, lat]: [number, number]) {
  return !!b && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

export function App() {
  const isPhone = useIsPhone();

  const [q, setQ] = useState("");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(DEFAULT_TIME_WINDOW);
  const [workplace, setWorkplace] = useState<WorkplaceFilter>("all");
  const [region, setRegion] = useState<Region>(GTA);
  const [viewport, setViewport] = useState<{ bbox: Bbox; zoom: number } | null>(null);
  const [flyTo, setFlyTo] = useState<FlyTarget | null>(null);
  const [overlay, setOverlayState] = useState<Overlay | null>(null);
  const listScroll = useRef(0);
  const trigger = useRef<HTMLElement | null>(null);
  const filterKey = `${q}|${timeWindow}|${workplace}|${region.region_id}`;

  const search = useJobSearch({
    q,
    regionId: region.region_id,
    bbox: viewport?.bbox ?? null,
    timeWindow,
    workplace,
    zoom: viewport?.zoom ?? null,
  });
  const pages = useGroupPages(search.data);
  const coverage = useCoverage();
  const features = useMemo(
    () => (search.data?.map_meta.mode === "points" ? (search.data.map.features as unknown as GeoJSON.Feature[]) : []),
    [search.data],
  );

  // Every job we currently know about from this search (list pages + map features).
  const known = useMemo(() => {
    const byId = new Map<string, JobCard>();
    for (const g of GROUPS) for (const j of pages.items(g)) byId.set(j.id, j);
    return byId;
  }, [pages]);

  /** Open an overlay, remembering what had focus so closing can return there. */
  const open = useCallback((next: Overlay) => {
    setOverlayState((cur) => {
      if (!cur) trigger.current = document.activeElement as HTMLElement | null;
      return next;
    });
  }, []);
  const close = useCallback(() => {
    setOverlayState(null);
    const el = trigger.current;
    trigger.current = null;
    requestAnimationFrame(() => el?.isConnected && el.focus({ preventScroll: true }));
  }, []);

  // A job that disappears because the filters changed is closed (§10).
  useEffect(() => {
    if (overlay?.kind !== "detail" || !search.data || search.isPlaceholderData) return;
    if (overlay.filterKey === filterKey) return;
    const stillThere = known.has(overlay.jobId) || jobCoordinates(features, overlay.jobId) !== null;
    if (!stillThere) setOverlayState(null);
  }, [overlay, filterKey, search.data, search.isPlaceholderData, known, features]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (overlay?.kind === "detail" || overlay?.kind === "site")) {
        if (overlay.kind === "detail" && overlay.fromList) setOverlayState({ kind: "list" });
        else close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, close]);

  const onViewportChange = useCallback((bbox: Bbox, zoom: number) => setViewport({ bbox, zoom }), []);

  const showJob = useCallback(
    (jobId: string, at: [number, number] | null, wp: string, fromList = false) =>
      open({ kind: "detail", jobId, at, workplace: wp, fromList, filterKey }),
    [open, filterKey],
  );

  const selectFromList = useCallback(
    (job: JobCard) => {
      const at = jobCoordinates(features, job.id);
      if (at && !inside(viewport?.bbox, at)) setFlyTo({ kind: "point", lon: at[0], lat: at[1] });
      showJob(job.id, at, job.workplace_type, true);
    },
    [features, viewport, showJob],
  );

  const showCompany = useCallback(
    (job: JobCard) => {
      const m = job.markers[0];
      if (!m) return;
      setFlyTo({ kind: "point", lon: m.lon, lat: m.lat, zoom: 13 });
      showJob(job.id, [m.lon, m.lat], job.workplace_type, true);
    },
    [showJob],
  );

  const changeRegion = useCallback((r: Region) => {
    setRegion(r);
    setFlyTo({ kind: "bbox", bbox: r.bbox as Bbox });
  }, []);

  // Jobs at one address: names come from what's loaded, the rest from /jobs/{id}.
  const siteIds = overlay?.kind === "site" ? overlay.jobIds : [];
  const missing = siteIds.filter((id) => !known.has(id));
  const fetched = useQueries({
    queries: missing.map((id) => ({
      queryKey: ["job", id],
      queryFn: ({ signal }: { signal: AbortSignal }) => apiGet<JobDetail>(`/jobs/${id}`, signal),
    })),
  });
  const pickerJobs: PickerJob[] = siteIds
    .map((id) => {
      const card = known.get(id);
      if (card) return card;
      const detail = fetched.find((r) => r.data?.id === id)?.data;
      return detail
        ? { id, title: detail.title, company: detail.company.name, workplace_type: detail.workplace_type }
        : null;
    })
    .filter((j): j is PickerJob => j !== null);

  const selection: MapSelection | null =
    overlay?.kind === "detail" && overlay.at
      ? {
          lon: overlay.at[0],
          lat: overlay.at[1],
          workplace: overlay.workplace,
          count: 1,
          inferred: features.some((f) => {
            const p = f.properties as { job_id?: string; inferred?: boolean } | null;
            return p?.job_id === overlay.jobId && p.inferred === true;
          }),
        }
      : overlay?.kind === "site"
        ? { lon: overlay.at[0], lat: overlay.at[1], workplace: "mixed", count: overlay.jobIds.length }
        : null;

  const detailCard =
    overlay?.kind === "detail" ? (
      <JobDetailCard
        jobId={overlay.jobId}
        onClose={close}
        onBack={overlay.fromList ? () => setOverlayState({ kind: "list" }) : undefined}
      />
    ) : overlay?.kind === "site" ? (
      <SameSitePicker
        jobs={pickerJobs}
        total={overlay.jobIds.length}
        onPick={(job) => showJob(job.id, overlay.at, job.workplace_type)}
        onClose={close}
      />
    ) : null;
  // Desktop: beside the point. Phone, or a job with no pin: a bottom card.
  const anchored = !isPhone && selection !== null;

  const sources = coverage.data
    ? Object.values(coverage.data.sources).reduce((n, s) => n + s.sources, 0)
    : null;
  const counts = search.data?.counts;

  return (
    <div className={styles.app}>
      <h1 className="visually-hidden">{t.appName}</h1>
      <MapView
        data={search.data}
        initialBbox={INITIAL_BBOX}
        selection={selection}
        popover={anchored ? detailCard : null}
        flyTo={flyTo}
        onViewportChange={onViewportChange}
        onSelectJob={(id, at) => {
          const f = features.find((x) => (x.properties as { job_id?: string })?.job_id === id);
          showJob(id, at, String((f?.properties as { workplace_type?: string })?.workplace_type ?? "unknown"));
        }}
        onStack={(jobIds, at) => open({ kind: "site", jobIds, at })}
        onBackgroundClick={() => overlay && overlay.kind !== "list" && close()}
      />

      <SearchDock
        q={q}
        onQ={setQ}
        timeWindow={timeWindow}
        onTimeWindow={setTimeWindow}
        workplace={workplace}
        onWorkplace={setWorkplace}
        region={region}
        onRegion={changeRegion}
        open={overlay?.kind === "filters" || overlay?.kind === "area" ? overlay.kind : null}
        onOpen={(kind) => open({ kind })}
        onClose={close}
      />

      {!anchored && detailCard && <div className={styles.bottomCard}>{detailCard}</div>}

      {overlay?.kind === "list" && (
        <ListSheet
          title={
            <>
              {t.results} <span className={styles.total}>{counts?.total ?? "…"}</span>
            </>
          }
          subtitle={
            coverage.data && sources !== null
              ? t.coverage(sources, relativeTime(coverage.data.last_successful_sync_at) ?? "—")
              : undefined
          }
          onClose={close}
          scrollKey={listScroll}
        >
          <ResultsPanel
            data={search.data}
            isLoading={search.isPending}
            isError={search.isError}
            stale={search.stale}
            isFetching={search.isFetching}
            items={pages.items}
            hasMore={pages.hasMore}
            loadingGroup={pages.loading}
            onLoadMore={pages.loadMore}
            onRetry={() => search.refetch()}
            selectedJobId={null}
            onSelect={selectFromList}
            onShowCompany={showCompany}
          />
        </ListSheet>
      )}

      {/* Hidden, not unmounted, under the sheet/card so focus can return to its List button. */}
      <div className={styles.bottomBar} hidden={overlay?.kind === "list" || (isPhone && detailCard !== null)}>
        {search.isError && !search.data ? (
          <div className={`${styles.countPill} ${styles.errorPill}`} role="alert">
            <span>{t.errorTitle}</span>
            <button type="button" className={styles.inlineButton} onClick={() => search.refetch()}>
              {t.retry}
            </button>
          </div>
        ) : (
          <div className={styles.countPill} role="status" aria-live="polite">
            {!counts ? (
              <>
                <Icon name="star" className={styles.spin} />
                {t.searching}
              </>
            ) : (
              <>
                <Icon name="star" className={styles.countStar} />
                <strong className={styles.countNum}>{counts.in_view}</strong>
                <span>{t.inArea}</span>
                {search.isFetching && <Icon name="star" className={`${styles.spin} ${styles.small}`} />}
              </>
            )}
            {search.stale && (
              <button type="button" className={styles.staleTag} onClick={() => search.refetch()}>
                {t.staleShort} · {t.retry}
              </button>
            )}
          </div>
        )}
        <button
          type="button"
          className={styles.listButton}
          onClick={() => open({ kind: "list" })}
          aria-label={counts ? t.viewListFull(counts.total) : t.viewList}
        >
          <Icon name="list" />
          {t.viewList}
          {counts && <span className={styles.listCount}>{counts.total}</span>}
        </button>
      </div>
    </div>
  );
}
