import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiError,
  apiGet,
  type Coverage,
  type GroupName,
  type JobCard,
  type Region,
  type SearchPage,
  type SearchParams,
  type SearchResponse,
  searchPath,
} from "../../lib/api";
import { useDebounced } from "../../lib/useDebounced";

const REFRESH_MS = 5 * 60 * 1000; // light periodic refresh; no websockets needed (§10)

export function useJobSearch(params: SearchParams) {
  const q = useDebounced(params.q, 300);
  const effective = { ...params, q };
  const query = useQuery({
    queryKey: ["search", effective],
    queryFn: ({ signal }) => apiGet<SearchResponse>(searchPath(effective), signal),
    enabled: effective.bbox !== null,
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
    staleTime: 30_000,
    retry: 1,
  });
  // Results are "stale" when the newest request failed but older data is still on screen.
  const stale = query.isError && query.data !== undefined;
  return { ...query, stale };
}

interface ExtraPages {
  /** The search these pages belong to; pages of any other search are never shown. */
  searchId: string;
  items: Record<GroupName, JobCard[]>;
  cursors: Record<GroupName, string | null>;
}

/** Extra pages per group, read from the server-side snapshot of the same search.
 *
 * Pages are tied to the `search_id` that produced them. When the search changes, in-flight
 * page requests are aborted, and a response that still arrives late is dropped unless its
 * search is still the current one — so pages of an old query never mix into a new one. */
export function useGroupPages(search: SearchResponse | undefined) {
  const queryClient = useQueryClient();
  const [extra, setExtra] = useState<ExtraPages | null>(null);
  const [loading, setLoading] = useState<GroupName | null>(null);
  const currentId = useRef<string | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const searchId = search?.search_id ?? null;
  currentId.current = searchId;

  useEffect(() => {
    // New search: drop the previous search's page requests.
    return () => {
      inflight.current?.abort();
      inflight.current = null;
      setLoading(null);
    };
  }, [searchId]);

  const own = extra && extra.searchId === searchId ? extra : null;
  const cursorOf = (g: GroupName): string | null =>
    own ? own.cursors[g] : (search?.groups[g].next_cursor ?? null);

  const loadMore = useCallback(
    async (group: GroupName) => {
      if (!search) return;
      const id = search.search_id;
      const base = extra && extra.searchId === id ? extra : null;
      const cursor = base ? base.cursors[group] : search.groups[group].next_cursor;
      if (!cursor) return;
      inflight.current?.abort();
      const ctrl = new AbortController();
      inflight.current = ctrl;
      setLoading(group);
      try {
        const page = await apiGet<SearchPage>(
          `/search/${id}/jobs?cursor=${encodeURIComponent(cursor)}&limit=30`,
          ctrl.signal,
        );
        if (ctrl.signal.aborted || currentId.current !== id) return; // stale response
        setExtra((e) => {
          const prev: ExtraPages =
            e && e.searchId === id
              ? e
              : {
                  searchId: id,
                  items: { in_view: [], remote_elsewhere: [], location_unverified: [] },
                  cursors: {
                    in_view: search.groups.in_view.next_cursor,
                    remote_elsewhere: search.groups.remote_elsewhere.next_cursor,
                    location_unverified: search.groups.location_unverified.next_cursor,
                  },
                };
          return {
            searchId: id,
            items: { ...prev.items, [group]: [...prev.items[group], ...page.items] },
            cursors: { ...prev.cursors, [group]: page.next_cursor },
          };
        });
      } catch (err) {
        if ((err as Error).name === "AbortError" || currentId.current !== id) return;
        if (err instanceof ApiError && err.code === "SEARCH_EXPIRED") {
          // A result closed or the snapshot timed out: run the whole search again.
          await queryClient.invalidateQueries({ queryKey: ["search"] });
        } else {
          throw err;
        }
      } finally {
        if (inflight.current === ctrl) {
          inflight.current = null;
          setLoading(null);
        }
      }
    },
    [extra, search, queryClient],
  );

  const items = (group: GroupName): JobCard[] =>
    search ? [...search.groups[group].items, ...(own?.items[group] ?? [])] : [];

  return { items, loadMore, hasMore: (g: GroupName) => cursorOf(g) !== null, loading };
}

export function useRegions(q: string) {
  const debounced = useDebounced(q, 250);
  return useQuery({
    queryKey: ["regions", debounced],
    queryFn: ({ signal }) =>
      apiGet<{ items: Region[] }>(`/regions?q=${encodeURIComponent(debounced)}`, signal),
    staleTime: 60 * 60 * 1000,
  });
}

export function useCoverage() {
  return useQuery({
    queryKey: ["coverage"],
    queryFn: ({ signal }) => apiGet<Coverage>("/coverage", signal),
    refetchInterval: REFRESH_MS,
  });
}
