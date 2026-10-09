import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";

import { t } from "../lib/strings";
import { card, detail, searchResponse } from "../test/fixtures";

// jsdom has no WebGL: replace the map with a stub that reports a viewport like the real one.
let reportViewport: ((bbox: [number, number, number, number], zoom: number) => void) | null = null;
vi.mock("../features/map/MapView", () => ({
  MapView: (props: { onViewportChange: (b: [number, number, number, number], z: number) => void }) => {
    reportViewport = props.onViewportChange;
    return <div data-testid="map" />;
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

test("no search is sent until the map reports its viewport, then bbox is included", async () => {
  renderApp();
  await waitFor(() => expect(screen.getByTestId("map")).toBeInTheDocument());
  expect(searches()).toHaveLength(0);
  act(() => reportViewport!([-79.5, 43.6, -79.3, 43.7], 12));
  await screen.findByText("Backend Engineer");
  expect(searches()[0]).toContain("bbox=-79.50000%2C43.60000%2C-79.30000%2C43.70000");
  expect(searches()[0]).toContain("region_id=gta");
});

test("keyword is debounced and filters reach the request", async () => {
  const user = userEvent.setup();
  renderApp();
  act(() => reportViewport!([-79.5, 43.6, -79.3, 43.7], 12));
  await screen.findByText("Backend Engineer");
  await user.type(screen.getByLabelText(t.searchLabel), "nurse");
  await user.selectOptions(screen.getByLabelText(t.timeLabel), "3d");
  await user.click(screen.getByLabelText(new RegExp(`^${t.workplaces.hybrid}$`)));
  await waitFor(() => {
    const last = searches().at(-1)!;
    expect(last).toContain("q=nurse");
    expect(last).toContain("time_window=3d");
    expect(last).toContain("workplace=hybrid");
  });
  // Debounce: no request was sent for the partial words "n", "nu", ...
  expect(searches().filter((u) => /q=nu(&|$)/.test(u))).toHaveLength(0);
});

test("clicking a result opens its detail; a selection that disappears is cleared", async () => {
  const user = userEvent.setup();
  renderApp();
  act(() => reportViewport!([-79.5, 43.6, -79.3, 43.7], 12));
  await user.click(await screen.findByRole("button", { name: /Backend Engineer/ }));
  expect(await screen.findByRole("link", { name: /Apply on employer site/ })).toBeInTheDocument();

  searchBodies = [searchResponse({ in_view: [card({ id: "other", title: "Barista" })] })];
  act(() => reportViewport!([-79.6, 43.6, -79.4, 43.7], 12));
  expect(await screen.findByText("Barista")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Apply on employer site/ })).toBeNull();
});

test("changing the area updates the remote-eligibility region shown to the user", async () => {
  const user = userEvent.setup();
  renderApp();
  act(() => reportViewport!([-79.5, 43.6, -79.3, 43.7], 12));
  await screen.findByText("Backend Engineer");
  expect(screen.getByRole("button", { name: /Remote jobs open to: GTA/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Remote jobs open to: GTA/ }));
  await user.click(await screen.findByRole("button", { name: /Mississauga/ }));
  expect(screen.getByRole("button", { name: /Remote jobs open to: Mississauga/ })).toBeInTheDocument();
  await waitFor(() => expect(searches().at(-1)).toContain("region_id=mississauga"));
});
