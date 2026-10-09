import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

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

/** Extra pages per group, read from the server-side snapshot of the same search. */
export function useGroupPages(search: SearchResponse | undefined) {
  const queryClient = useQueryClient();
  const [extra, setExtra] = useState<Record<GroupName, JobCard[]>>({
    in_view: [],
    remote_elsewhere: [],
    location_unverified: [],
  });
  const [cursors, setCursors] = useState<Record<GroupName, string | null>>({
    in_view: null,
    remote_elsewhere: null,
    location_unverified: null,
  });
  const [loading, setLoading] = useState<GroupName | null>(null);

  useEffect(() => {
    setExtra({ in_view: [], remote_elsewhere: [], location_unverified: [] });
    setCursors({
      in_view: search?.groups.in_view.next_cursor ?? null,
      remote_elsewhere: search?.groups.remote_elsewhere.next_cursor ?? null,
      location_unverified: search?.groups.location_unverified.next_cursor ?? null,
    });
  }, [search?.search_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(
    async (group: GroupName) => {
      const cursor = cursors[group];
      if (!search || !cursor) return;
      setLoading(group);
      try {
        const page = await apiGet<SearchPage>(
          `/search/${search.search_id}/jobs?cursor=${encodeURIComponent(cursor)}&limit=30`,
        );
        setExtra((e) => ({ ...e, [group]: [...e[group], ...page.items] }));
        setCursors((c) => ({ ...c, [group]: page.next_cursor }));
      } catch (err) {
        if (err instanceof ApiError && err.code === "SEARCH_EXPIRED") {
          // A result closed or the snapshot timed out: run the whole search again.
          await queryClient.invalidateQueries({ queryKey: ["search"] });
        } else {
          throw err;
        }
      } finally {
        setLoading(null);
      }
    },
    [cursors, search, queryClient],
  );

  const items = (group: GroupName): JobCard[] =>
    search ? [...search.groups[group].items, ...extra[group]] : [];

  return { items, loadMore, hasMore: (g: GroupName) => cursors[g] !== null, loading };
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
