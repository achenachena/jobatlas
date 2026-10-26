/** Data hooks for the atlas. Every query is bound to one release id, so frames, series and
 * the timeline always come from the same published version (spec §5, §10). */
import { keepPreviousData, type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  atlasGet,
  type Capabilities,
  type CitiesResponse,
  type Dataset,
  type FrameResponse,
  type SeriesResponse,
  type SourcesResponse,
  type TimelineResponse,
  type VersionResponse,
  type WindowKey,
} from "./api";
import { cityScaleMax } from "./scale";
import { addDays, daysBetween } from "./state";

export const CHUNK_DAYS = 120;

export const capabilitiesQuery = (dataset: Dataset) => ({
  queryKey: ["atlas", "caps", dataset],
  queryFn: ({ signal }: { signal: AbortSignal }) => atlasGet<Capabilities>("/capabilities", { dataset }, signal),
  staleTime: Infinity,
});

export function useCapabilities(dataset: Dataset, enabled = true) {
  return useQuery({ ...capabilitiesQuery(dataset), enabled });
}

export const citiesQuery = (dataset: Dataset, release: string | null | undefined) => ({
  queryKey: ["atlas", "cities", dataset, release],
  queryFn: ({ signal }: { signal: AbortSignal }) => atlasGet<CitiesResponse>("/cities", { dataset, release: release ?? undefined }, signal),
  staleTime: Infinity,
});

export const frameQuery = (dataset: Dataset, release: string | null, occupation: string, window: string, day: string | null) => ({
  queryKey: ["atlas", "frame", dataset, release, occupation, window, day],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    atlasGet<FrameResponse>("/frame", { dataset, release: release ?? undefined, occupation, window, date: day ?? undefined }, signal),
  staleTime: Infinity,
});

/** The first view's data, requested the moment the capabilities arrive (not after the map's
 * first render, which would otherwise hold the requests back): cities, the shown day's counts
 * and the national summary, under the keys the hooks read. */
export function prefetchFirstView(qc: QueryClient, s: { dataset: Dataset; occupation: string; window: WindowKey; date: string | null }): void {
  void qc.fetchQuery(capabilitiesQuery(s.dataset)).then((caps) => {
    const { release_id: release, history_start: start, data_through: end } = caps;
    if (!release || !start || !end) return;
    const day = !s.date ? end : s.date < start ? start : s.date > end ? end : s.date;
    const a = { dataset: s.dataset, release, occupation: s.occupation, window: s.window, historyStart: start, dataThrough: end };
    void qc.prefetchQuery(citiesQuery(s.dataset, release));
    void qc.prefetchQuery({ ...timelineQuery(a, [day, day]), staleTime: Infinity });
    void qc.prefetchQuery(frameQuery(s.dataset, release, s.occupation, s.window, day));
  }, () => undefined); // the hooks report the error
}

export function useCities(dataset: Dataset, release: string | null | undefined) {
  return useQuery({
    ...citiesQuery(dataset, release),
    enabled: !!release,
    // a new release or dataset keeps the map on screen until its cities arrive
    placeholderData: keepPreviousData,
  });
}

export function useSources() {
  return useQuery({
    queryKey: ["atlas", "sources"],
    queryFn: ({ signal }) => atlasGet<SourcesResponse>("/sources", {}, signal),
    staleTime: Infinity,
  });
}

/** Chunk [start, end] containing `date`, aligned to the history start. */
export function chunkFor(date: string, historyStart: string, dataThrough: string): [string, string] {
  const i = Math.floor(daysBetween(historyStart, date) / CHUNK_DAYS);
  const start = addDays(historyStart, i * CHUNK_DAYS);
  const end = addDays(start, CHUNK_DAYS - 1);
  return [start, daysBetween(end, dataThrough) < 0 ? dataThrough : end];
}

interface TimelineArgs {
  dataset: Dataset;
  release: string | null | undefined;
  occupation: string;
  window: WindowKey;
  historyStart: string | null | undefined;
  dataThrough: string | null | undefined;
}

export function timelineQuery(a: TimelineArgs, range: [string, string]) {
  return {
    queryKey: ["atlas", "timeline", a.dataset, a.release, a.occupation, a.window, range[0], range[1]],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      atlasGet<TimelineResponse>(
        "/timeline",
        { dataset: a.dataset, release: a.release ?? undefined, occupation: a.occupation, window: a.window, start: range[0], end: range[1] },
        signal,
      ),
    staleTime: Infinity,
  };
}

/** The chunk containing `date`; the next one is prefetched while playing. Stale responses
 * never replace a newer selection (query keys carry the whole selection). */
export function useTimelineChunk(a: TimelineArgs, date: string | null, prefetchNext: boolean) {
  const qc = useQueryClient();
  const range = useMemo(
    () => (date && a.historyStart && a.dataThrough ? chunkFor(date, a.historyStart, a.dataThrough) : null),
    [date, a.historyStart, a.dataThrough],
  );
  const q = useQuery({
    ...timelineQuery(a, range ?? ["", ""]),
    enabled: !!range && !!a.release,
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (!prefetchNext || !range || !a.dataThrough || !a.historyStart) return;
    if (daysBetween(range[1], a.dataThrough) <= 0) return;
    const next = chunkFor(addDays(range[1], 1), a.historyStart, a.dataThrough);
    void qc.prefetchQuery(timelineQuery(a, next));
  }, [prefetchNext, range, a, qc]);
  return q;
}

/** Fixed scale for a whole playback: the largest city count of the "all" occupation (shared)
 * or of the selected occupation (fit), over the whole release history. */
export function useScaleMax(a: TimelineArgs, mode: "shared" | "fit", caps: Capabilities | undefined) {
  const occ = mode === "shared" ? "all" : a.occupation;
  const cityMax = caps && caps.release_id === a.release ? cityScaleMax(caps.quality, occ, a.window) : null;
  const q = useQuery({
    ...timelineQuery({ ...a, occupation: occ }, [a.dataThrough ?? "", a.dataThrough ?? ""]),
    enabled: cityMax == null && !!a.release && !!a.dataThrough,
    placeholderData: keepPreviousData, // keep the map on screen until the new scale arrives
  });
  // Demo/legacy responses without published city metadata keep their existing scale.
  return cityMax ?? q.data?.max_count ?? null;
}

export function useSeries(
  dataset: Dataset,
  release: string | null | undefined,
  city: string | null,
  occupation: string,
  window: WindowKey,
  end: string | null,
) {
  return useQuery({
    queryKey: ["atlas", "series", dataset, release, city, occupation, window, end],
    queryFn: ({ signal }) =>
      atlasGet<SeriesResponse>(`/cities/${city}/series`, { dataset, release: release ?? undefined, occupation, window, end: end ?? undefined, days: 90 }, signal),
    enabled: !!release && !!city && !!end,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}

/** One city's whole replay range (single-city rows only), for its history chart. */
export function useCityHistory(dataset: Dataset, release: string, city: string, occupation: string, start: string, end: string) {
  return useQuery({
    queryKey: ["atlas", "history", dataset, release, city, occupation, start, end],
    queryFn: ({ signal }) =>
      atlasGet<SeriesResponse>(`/cities/${city}/series`, { dataset, release, occupation, window: "30d", end, days: daysBetween(start, end) + 1 }, signal),
    staleTime: Infinity,
  });
}

/** Version poll interval: 60 s (spec §10); tests may shorten it. */
const POLL_MS = Number(import.meta.env.VITE_ATLAS_POLL_MS ?? 60_000);

/** Polls /version while the page is visible (spec §10). */
export function useLatestVersion(dataset: Dataset) {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return useQuery({
    queryKey: ["atlas", "version", dataset],
    queryFn: ({ signal }) => atlasGet<VersionResponse>("/version", { dataset }, signal),
    refetchInterval: visible ? POLL_MS : false,
    refetchIntervalInBackground: false,
  });
}
