import type { Page, Route } from "@playwright/test";

/** Synthetic data for deterministic E2E (clearly fake names). */
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const job = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: "Backend Engineer", company: "Fixture Robotics", workplace_type: "hybrid",
  location_status: "exact_work_location", location_label: "Toronto, ON",
  markers: [{ lon: -79.3832, lat: 43.6487, role: "work_site", address: "1 Fixture Way, Toronto, ON" }],
  remote_eligibility_text: null, posted_at: iso(5 * 3600e3), posted_date: null, posted_precision: "datetime",
  posted_basis: "original", first_seen_at: iso(86400e3), listed_after: null, last_verified_at: iso(600e3), employment_type: null,
  salary: { min: 110000, max: 140000, currency: "CAD", period: "year", raw_text: null },
  apply_url: "https://example.test/apply/" + id, ...over,
});

export const JOBS = {
  inView: [
    job("j1"),
    job("j2", { title: "Senior Back-End Engineer", workplace_type: "on_site", markers: [{ lon: -79.39, lat: 43.66, role: "work_site", address: "2 Fixture Ave" }] }),
  ],
  remote: [job("r1", { title: "Platform Engineer", workplace_type: "remote", location_status: "company_location",
    remote_eligibility_text: "Remote - Canada", markers: [{ lon: -122.4, lat: 37.79, role: "headquarters", address: "500 Fixture St, San Francisco" }] })],
  unverified: [job("u1", { title: "Payroll Accountant", location_status: "unverified", markers: [], workplace_type: "unknown" })],
};

export function searchBody(q: string | null, timeWindow: string) {
  // Mimics the backend's variant matching ("Back-End" == "Backend") for the first keyword.
  const norm = (s: string) => s.toLowerCase().replace(/[-\s]/g, "");
  const match = (title: string) => !q || norm(title).includes(norm(q.split(" ")[0]!));
  const inView = JOBS.inView.filter((j) => match(j.title as string));
  const remote = JOBS.remote.filter((j) => match(j.title as string));
  const unverified = JOBS.unverified.filter((j) => match(j.title as string));
  return {
    search_id: "fixture-search", as_of: new Date().toISOString(), expires_at: new Date(now + 300e3).toISOString(),
    filters: { q, region_id: "gta", bbox: [-79.64, 43.58, -79.11, 43.86], time_window: timeWindow, workplace: "all" },
    counts: { total: inView.length + remote.length + unverified.length, in_view: inView.length, remote_elsewhere: remote.length, location_unverified: unverified.length },
    groups: {
      in_view: { items: inView, next_cursor: null },
      remote_elsewhere: { items: remote, next_cursor: null },
      location_unverified: { items: unverified, next_cursor: null },
    },
    map: { type: "FeatureCollection", features: inView.map((j) => ({ type: "Feature",
      geometry: { type: "Point", coordinates: [(j.markers as any)[0].lon, (j.markers as any)[0].lat] },
      properties: { job_id: j.id, workplace_type: j.workplace_type, location_role: "work_site" } })) },
    map_meta: { complete: true, mode: "points", unique_job_count: inView.length, marker_count: inView.length },
    warnings: timeWindow !== "all" ? [{ code: "UNTRUSTED_POSTING_TIME_EXCLUDED", message: "x", count: 2 }] : [],
  };
}

export async function mockApi(page: Page, opts: { failSearch?: boolean } = {}) {
  const calls: string[] = [];
  await page.route("http://api.fixture/api/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    calls.push(url.pathname + url.search);
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body),
        headers: { "access-control-allow-origin": "*", "x-request-id": "fixture-req" } });
    if (url.pathname.endsWith("/search")) {
      if (opts.failSearch) return json({ error: { code: "DEPENDENCY_UNAVAILABLE", message: "down" }, request_id: "x" }, 503);
      return json(searchBody(url.searchParams.get("q"), url.searchParams.get("time_window") ?? "all"));
    }
    if (url.pathname.includes("/jobs/")) {
      const id = url.pathname.split("/").pop()!;
      const all = [...JOBS.inView, ...JOBS.remote, ...JOBS.unverified];
      const j = all.find((x) => x.id === id) ?? JOBS.inView[0]!;
      return json({ id: j.id, title: j.title, company: { name: j.company, website: null }, workplace_type: j.workplace_type,
        status: "active", is_open_opportunity: true, posted_at: j.posted_at, posted_date: null, posted_precision: "datetime",
        posted_basis: "original", first_seen_at: j.first_seen_at, listed_after: null, last_verified_at: j.last_verified_at, closed_at: null,
        close_reason: null, location_status: j.location_status, location_label: j.location_label,
        locations: (j.markers as any[]).map((m) => ({ role: m.role, address: m.address, coordinates: [m.lon, m.lat], precision: "rooftop",
          evidence: { method: "fixture", excerpt: null, source_url: null, observed_at: null } })),
        eligibility: { status: "not_applicable", text: j.remote_eligibility_text, regions: [], note: null }, employment_type: "Full-time",
        salary: j.salary, description_text: "Fixture description.", source: { provider: "greenhouse", board_url: null, job_url: "https://example.test/job",
          source_updated_at: null, source_republished_at: null, last_seen_at: null }, sources: [], apply_url: j.apply_url });
    }
    if (url.pathname.endsWith("/coverage"))
      return json({ as_of: new Date().toISOString(), sources: { greenhouse: { sources: 12, by_status: { active: 12 } } },
        failing_sources: 0, last_successful_sync_at: iso(120e3), jobs: { open_jobs: 4, pending: 0, closed: 0, located: 2 },
        last_discovery_run: null, limitations: [] });
    if (url.pathname.endsWith("/regions")) return json({ items: [] });
    return json({}, 404);
  });
  return calls;
}
