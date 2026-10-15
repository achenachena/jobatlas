import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AtlasApp } from "./AtlasApp";

const GEO = {
  bbox: [-100, -100, 100, 100],
  provinces: [{ code: "ON", name: "Ontario", polygons: [[[[-100, -100], [100, -100], [100, 100], [-100, -100]]]] }],
  neighbours: [],
  lakes: [],
};
const CITIES = {
  dataset_id: "jobbank", data_mode: "real", release_id: "r1", attribution: "GeoNames",
  cities: [
    { city_id: "ca-on-toronto", name: "Toronto", province: "ON", country: "CA", lat: 43.7, lon: -79.4, population: 1, aliases: [], kind: "city", evidence: "x" },
    { city_id: "ca-qc-montreal", name: "Montréal", province: "QC", country: "CA", lat: 45.5, lon: -73.6, population: 1, aliases: [], kind: "city", evidence: "x" },
  ],
};

function caps(mode: "real" | "demo" | "not_configured") {
  return {
    dataset_id: mode === "demo" ? "demo-v1" : "jobbank", data_mode: mode, release_id: mode === "not_configured" ? null : "r1",
    reason: mode === "not_configured" ? "Real data source is not connected yet." : null,
    metrics: ["new_postings"], windows: ["1d", "7d", "30d"], default_window: "7d", geo_levels: ["city"],
    occupations: [{ id: "all", label: "All jobs", note: "" }, { id: "bartender", label: "Bartender", note: "" }],
    history_start: mode === "not_configured" ? null : "2026-08-01", data_through: mode === "not_configured" ? null : "2026-09-30",
    partial_latest_day: false, gaps: [], playback: mode !== "not_configured", playback_reason: null, stale: false,
    publication: "monthly", reporting_timezone: "America/Toronto", quality: {},
  };
}

function timeline(occupation: string) {
  return {
    dataset_id: "jobbank", data_mode: "real", release_id: "r1", metric: "new_postings", occupation, window: "7d",
    reporting_timezone: "America/Toronto", start: "2026-09-29", end: "2026-09-30",
    city_ids: ["ca-on-toronto", "ca-qc-montreal"], max_count: 400,
    frames: [{ date: "2026-09-30", quality: "complete", days_available: 7, counts: [395, 0], national: 400, notes: [] }],
  };
}

let calls: string[] = [];
function mockApi(mode: "real" | "demo" | "not_configured") {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname + url.search);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/atlas/canada-geo.json") return json(GEO);
    if (url.pathname.endsWith("/capabilities")) return json(caps(mode));
    if (mode === "not_configured" && url.searchParams.get("dataset") !== "demo")
      return json({ error: { code: "DATA_SOURCE_NOT_CONFIGURED", message: "not connected" } }, 503);
    if (url.pathname.endsWith("/cities")) return json({ ...CITIES, data_mode: mode });
    if (url.pathname.endsWith("/timeline")) return json({ ...timeline(url.searchParams.get("occupation") ?? "all"), data_mode: mode });
    if (url.pathname.endsWith("/version")) return json({ dataset_id: "jobbank", data_mode: mode, release_id: "r1", data_through: "2026-09-30", published_at: null, change_kind: "update" });
    if (url.pathname.endsWith("/sources")) return json({ sources: [], definitions: {}, attributions: [] });
    if (url.pathname.endsWith("/frame"))
      return json({ national: { total_unique: 400, total_reason: null, city_unconfirmed: 5, remote_canada: 0 }, cities: [], notes: [] });
    return json({}, 404);
  }));
}

function renderApp(search = "") {
  window.history.replaceState(null, "", `/${search}`);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AtlasApp />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

test("real source not configured: says so, offers labelled demo, never falls back silently", async () => {
  mockApi("not_configured");
  renderApp();
  expect(await screen.findByText("Data source not connected yet")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /View demo data/ })).toBeInTheDocument();
  expect(screen.queryByText(/Demo data · 示例数据/)).not.toBeInTheDocument();
  expect(calls.some((c) => c.includes("dataset=demo"))).toBe(false);
});

test("demo mode is labelled on screen", async () => {
  mockApi("demo");
  renderApp("?data=demo");
  expect(await screen.findByText(/Demo data · 示例数据/)).toBeInTheDocument();
  expect(screen.getByText(/DEMO DATA/)).toBeInTheDocument();
});

test("default view: all jobs, 7 days, latest date; no WebGL -> 2D map, not a blank page", async () => {
  mockApi("real");
  renderApp();
  expect(await screen.findByRole("img", { name: /2D view/ })).toBeInTheDocument();
  await waitFor(() => expect(calls.some((c) => c.includes("/timeline") && c.includes("occupation=all") && c.includes("window=7d"))).toBe(true));
  expect(screen.getByText("Sep 24 – Sep 30, 2026")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "All jobs" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");
  expect(screen.queryByText(/Demo data/)).not.toBeInTheDocument();
});

test("choosing an occupation requests its data and is kept in the URL", async () => {
  mockApi("real");
  renderApp();
  await screen.findByRole("img", { name: /2D view/ });
  await userEvent.click(screen.getByRole("radio", { name: "Bartender" }));
  await waitFor(() => expect(calls.some((c) => c.includes("/timeline") && c.includes("occupation=bartender"))).toBe(true));
  expect(window.location.search).toContain("occupation=bartender");
});

test("city list is keyboard reachable and shows exact counts", async () => {
  mockApi("real");
  renderApp();
  await screen.findByRole("img", { name: /2D view/ });
  await userEvent.click(screen.getByRole("button", { name: "City list" }));
  const item = await screen.findByRole("button", { name: /Toronto, ON\s*395/ });
  item.focus();
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("region", { name: "Toronto details" })).toBeInTheDocument();
});
