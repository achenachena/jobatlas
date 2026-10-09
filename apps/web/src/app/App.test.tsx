import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";

import { t } from "../lib/strings";
import { card, detail, searchResponse } from "../test/fixtures";

// jsdom has no WebGL: replace the map with a stub that reports a viewport like the real one
// and renders whatever the app anchors to the selected point.
let reportViewport: ((bbox: [number, number, number, number], zoom: number) => void) | null = null;
vi.mock("../features/map/MapView", () => ({
  MapView: (props: { onViewportChange: (b: [number, number, number, number], z: number) => void; popover: React.ReactNode }) => {
    reportViewport = props.onViewportChange;
    return <div data-testid="map">{props.popover}</div>;
  },
}));

const { App } = await import("./App");

let searchBodies: Array<ReturnType<typeof searchResponse>> = [];
let requested: string[] = [];

beforeEach(() => {
  requested = [];
  searchBodies = [searchResponse({ in_view: [card()] })];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/search?")) {
        const body = searchBodies.length > 1 ? searchBodies.shift()! : searchBodies[0];
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (url.includes("/jobs/")) return new Response(JSON.stringify(detail()), { status: 200 });
      if (url.includes("/coverage"))
        return new Response(JSON.stringify({ as_of: new Date().toISOString(), sources: { greenhouse: { sources: 3, by_status: {} } },
          failing_sources: 0, last_successful_sync_at: new Date().toISOString(),
          jobs: { open_jobs: 1, pending: 0, closed: 0, located: 1 }, last_discovery_run: null, limitations: [] }), { status: 200 });
      if (url.includes("/regions"))
        return new Response(JSON.stringify({ items: [{ region_id: "mississauga", name: "Mississauga", parent_id: "gta", kind: "municipality", bbox: [-79.8, 43.5, -79.5, 43.7], approximate: true, dataset_version: null }] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

const searches = () => requested.filter((u) => u.includes("/search?"));

const listButton = (n: number) => screen.findByRole("button", { name: t.viewListFull(n) });

test("no search is sent until the map reports its viewport, then bbox is included", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByTestId("map")).toBeInTheDocument());
  expect(searches()).toHaveLength(0);
  act(() => reportViewport!([-79.5, 43.6, -79.3, 43.7], 12));
  await listButton(1);
  expect(searches()[0]).toContain("bbox=-79.50000%2C43.60000%2C-79.30000%2C43.70000");
  expect(searches()[0]).toContain("region_id=gta");
});

test("the map owns the screen: no results column until the list is asked for", async () => {
  const user = userEvent.setup();
  renderApp();
  act(() => reportViewport!([-79.5, 43.6, -79.3, 43.7], 12));
  const button = await listButton(1);
  expect(screen.queryByRole("heading", { name: new RegExp(t.groups.in_view) })).toBeNull();
  expect(screen.queryByText(/employer job boards/)).toBeNull();
  await user.click(button);
  expect(await screen.findByRole("heading", { name: new RegExp(t.groups.in_view) })).toBeInTheDocument();
  expect(screen.getByText(/3 employer job boards/)).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("heading", { name: new RegExp(t.groups.in_view) })).toBeNull();
  await waitFor(() => expect(button).toHaveFocus()); // focus returns to the trigger
});

test("keyword is debounced and filters reach the request", async () => {
  const user = userEvent.setup();
  renderApp();
  act(() => reportViewport!([-79.5, 43.6, -79.3, 43.7], 12));
  await listButton(1);
  await user.type(screen.getByLabelText(t.searchLabel), "nurse");
  await user.click(screen.getByRole("button", { name: /^Filters/ }));
  await user.click(screen.getByLabelText(t.timeWindows["3d"]));
  await user.click(screen.getByLabelText(new RegExp(`^${t.workplaces.hybrid}$`)));
  await waitFor(() => {
    const last = searches().at(-1)!;
    expect(last).toContain("q=nurse");
    expect(last).toContain("time_window=3d");
    expect(last).toContain("workplace=hybrid");
  });
  // Debounce: no request was sent for the partial words "n", "nu", ...
  expect(searches().filter((u) => /q=nu(&|$)/.test(u))).toHaveLength(0);
  // Active filters show as removable chips next to the dock.
  await user.click(screen.getByRole("button", { name: t.done }));
  await user.click(screen.getByRole("button", { name: t.removeFilter(t.timeWindows["3d"]) }));
  await waitFor(() => expect(searches().at(-1)).toContain("time_window=all"));
});

test("a job opened from the list shows its card; it closes when new filters drop it", async () => {
  const user = userEvent.setup();
  renderApp();
  act(() => reportViewport!([-79.5, 43.6, -79.3, 43.7], 12));
  await user.click(await listButton(1));
  await user.click(await screen.findByRole("button", { name: /Backend Engineer/ }));
  expect(await screen.findByRole("link", { name: /Apply on employer site/ })).toBeInTheDocument();
  // one overlay at a time: the list made way for the card
  expect(screen.queryByRole("heading", { name: new RegExp(t.groups.in_view) })).toBeNull();

  searchBodies = [searchResponse({ in_view: [card({ id: "other", title: "Barista" })] })];
  await user.type(screen.getByLabelText(t.searchLabel), "barista");
  await waitFor(() => expect(screen.queryByRole("link", { name: /Apply on employer site/ })).toBeNull());
});

test("changing the area updates the remote-eligibility region shown to the user", async () => {
  const user = userEvent.setup();
  renderApp();
  act(() => reportViewport!([-79.5, 43.6, -79.3, 43.7], 12));
  await listButton(1);
  await user.click(screen.getByRole("button", { name: t.areaButton("GTA") }));
  expect(screen.getByRole("heading", { name: t.remoteRegion("GTA") })).toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: /Mississauga/ }));
  expect(screen.getByRole("button", { name: t.areaButton("Mississauga") })).toBeInTheDocument();
  await waitFor(() => expect(searches().at(-1)).toContain("region_id=mississauga"));
});
