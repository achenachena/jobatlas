import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { JobDetailPanel } from "../features/jobs/JobDetailPanel";
import { ResultsPanel } from "../features/jobs/ResultsPanel";
import { type PickerJob, SameSitePicker } from "../features/jobs/SameSitePicker";
import { type FlyTarget, MapView } from "../features/map/MapView";
import { FilterBar } from "../features/search/FilterBar";
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

export function App() {
  const [q, setQ] = useState("");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("all");
  const [workplace, setWorkplace] = useState<WorkplaceFilter>("all");
  const [region, setRegion] = useState<Region>(GTA);
  const [viewport, setViewport] = useState<{ bbox: Bbox; zoom: number } | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<FlyTarget | null>(null);
  const [sameSiteIds, setSameSiteIds] = useState<string[] | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

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

  // Every job we currently know about from this search (list pages + map features).
  const known = useMemo(() => {
    const byId = new Map<string, JobCard>();
    for (const g of GROUPS) for (const j of pages.items(g)) byId.set(j.id, j);
    return byId;
  }, [pages]);
  const mapIds = useMemo(
    () =>
      new Set(
        (search.data?.map.features ?? []).map(
          (f) => String((f as { properties?: { job_id?: string } }).properties?.job_id),
        ),
      ),
    [search.data],
  );

  // A selection that disappears because of new filters is cleared (§10).
  useEffect(() => {
    if (selectedJobId && search.data && !known.has(selectedJobId) && !mapIds.has(selectedJobId)) {
      setSelectedJobId(null);
    }
  }, [search.data, known, mapIds, selectedJobId]);

  const onViewportChange = useCallback((bbox: Bbox, zoom: number) => setViewport({ bbox, zoom }), []);

  const selectFromList = useCallback((job: JobCard) => {
    setSelectedJobId(job.id);
    const marker = job.markers[0];
    if (marker && job.location_status !== "company_location") {
      setFlyTo({ kind: "point", lon: marker.lon, lat: marker.lat });
    }
  }, []);

  const showCompany = useCallback((job: JobCard) => {
    const marker = job.markers[0];
    setSelectedJobId(job.id);
    if (marker) setFlyTo({ kind: "point", lon: marker.lon, lat: marker.lat, zoom: 13 });
  }, []);

  const changeRegion = useCallback((r: Region) => {
    setRegion(r);
    setFlyTo({ kind: "bbox", bbox: r.bbox as Bbox });
  }, []);

  // Jobs at one building: names come from what's loaded, the rest from /jobs/{id}.
  const missing = (sameSiteIds ?? []).filter((id) => !known.has(id));
  const fetched = useQueries({
    queries: missing.map((id) => ({
      queryKey: ["job", id],
      queryFn: ({ signal }: { signal: AbortSignal }) => apiGet<JobDetail>(`/jobs/${id}`, signal),
    })),
  });
  const pickerJobs: PickerJob[] = (sameSiteIds ?? [])
    .map((id) => {
      const card = known.get(id);
      if (card) return card;
      const detail = fetched.find((r) => r.data?.id === id)?.data;
      return detail
        ? { id, title: detail.title, company: detail.company.name, workplace_type: detail.workplace_type }
        : null;
    })
    .filter((j): j is PickerJob => j !== null);

  const sources = coverage.data
    ? Object.values(coverage.data.sources).reduce((n, s) => n + s.sources, 0)
    : null;

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            ✦
          </span>
          <div>
            <h1 className={styles.title}>{t.appName}</h1>
            <p className={styles.coverage}>
              {coverage.data && sources !== null
                ? t.coverage(sources, relativeTime(coverage.data.last_successful_sync_at) ?? "—")
                : t.tagline}
            </p>
          </div>
        </div>
        <FilterBar
          q={q}
          onQ={setQ}
          timeWindow={timeWindow}
          onTimeWindow={setTimeWindow}
          workplace={workplace}
          onWorkplace={setWorkplace}
          region={region}
          onRegion={changeRegion}
        />
      </header>

      <main className={styles.main}>
        <section className={styles.mapArea} aria-label={t.mapAreaTitle}>
          <span className={styles.mapLabel}>
            {t.mapAreaTitle}
            {search.data ? ` · ${search.data.counts.in_view}` : ""}
          </span>
          <MapView
            data={search.data}
            initialBbox={INITIAL_BBOX}
            selectedJobId={selectedJobId}
            flyTo={flyTo}
            onViewportChange={onViewportChange}
            onSelectJob={setSelectedJobId}
            onSameSite={setSameSiteIds}
          />
        </section>

        <section className={`${styles.panel} ${sheetOpen ? styles.sheetOpen : ""}`} aria-label={t.results}>
          <button
            type="button"
            className={styles.sheetHandle}
            onClick={() => setSheetOpen((o) => !o)}
            aria-expanded={sheetOpen}
          >
            <span className={styles.grip} aria-hidden="true" />
            {t.results} {search.data ? `(${search.data.counts.total})` : ""}
          </button>
          <div className={styles.panelScroll}>
            {selectedJobId ? (
              <JobDetailPanel jobId={selectedJobId} onClose={() => setSelectedJobId(null)} />
            ) : (
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
                selectedJobId={selectedJobId}
                onSelect={selectFromList}
                onShowCompany={showCompany}
              />
            )}
          </div>
        </section>
      </main>

      {sameSiteIds && (
        <SameSitePicker
          jobs={pickerJobs}
          onPick={(job) => {
            setSameSiteIds(null);
            setSelectedJobId(job.id);
          }}
          onClose={() => setSameSiteIds(null)}
        />
      )}
    </div>
  );
}
