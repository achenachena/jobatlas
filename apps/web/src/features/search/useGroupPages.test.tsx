import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, vi } from "vitest";

import type { SearchResponse } from "../../lib/api";
import { card, searchResponse } from "../../test/fixtures";
import { useGroupPages } from "./useSearch";

afterEach(() => vi.unstubAllGlobals());

function withCursor(id: string, title: string): SearchResponse {
  const r = searchResponse({ in_view: [card({ id: `${id}-1`, title })] }, { search_id: id });
  r.groups.in_view.next_cursor = `${id}-cursor`;
  return r;
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

test("a page of an old search that returns late never joins the new search", async () => {
  // The "Engineer" page request hangs until we release it.
  let release!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        if (String(input).includes("/search/engineer/jobs")) release = resolve;
      }),
    ),
  );
  const engineer = withCursor("engineer", "Engineer");
  const nurse = withCursor("nurse", "Nurse");
  const { result, rerender } = renderHook(({ s }) => useGroupPages(s), {
    initialProps: { s: engineer },
    wrapper,
  });

  let pending!: Promise<void>;
  act(() => {
    pending = result.current.loadMore("in_view");
  });
  rerender({ s: nurse }); // the user switches to "Nurse" before the page arrives
  release(new Response(JSON.stringify({
    search_id: "engineer", group: "in_view", next_cursor: null,
    items: [card({ id: "engineer-2", title: "Old Engineer page" })],
  }), { status: 200 }));
  await act(async () => {
    await pending;
  });

  expect(result.current.items("in_view").map((j) => j.id)).toEqual(["nurse-1"]);
  expect(result.current.hasMore("in_view")).toBe(true); // nurse's own cursor, untouched
  await waitFor(() => expect(result.current.loading).toBeNull());
});

test("pages of the current search still append normally", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    search_id: "engineer", group: "in_view", next_cursor: null,
    items: [card({ id: "engineer-2", title: "Engineer II" })],
  }), { status: 200 })));
  const { result } = renderHook(() => useGroupPages(withCursor("engineer", "Engineer")), { wrapper });
  await act(async () => {
    await result.current.loadMore("in_view");
  });
  expect(result.current.items("in_view").map((j) => j.id)).toEqual(["engineer-1", "engineer-2"]);
  expect(result.current.hasMore("in_view")).toBe(false);
});
