/** Explicitly synthetic fixtures for component and E2E tests (never shown to users). */
import type { JobCard, JobDetail, SearchResponse } from "../lib/api";

export function card(over: Partial<JobCard> = {}): JobCard {
  return {
    id: "job-1",
    title: "Backend Engineer",
    company: "Fixture Co",
    workplace_type: "hybrid",
    location_status: "exact_work_location",
    location_label: "Toronto, ON",
    markers: [{ lon: -79.38, lat: 43.65, role: "work_site", address: "1 Test St, Toronto, ON" }],
    remote_eligibility_text: null,
    posted_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    posted_date: null,
    posted_precision: "datetime",
    posted_basis: "original",
    first_seen_at: new Date(Date.now() - 86400_000).toISOString(),
    listed_after: null,
    last_verified_at: new Date(Date.now() - 600_000).toISOString(),
    employment_type: null,
    salary: null,
    apply_url: "https://example.test/apply",
    ...over,
  };
}

export function searchResponse(groups: Partial<Record<"in_view" | "remote_elsewhere" | "location_unverified", JobCard[]>> = {}, over: Partial<SearchResponse> = {}): SearchResponse {
  const g = { in_view: [], remote_elsewhere: [], location_unverified: [], ...groups };
  const features = g.in_view.flatMap((j) =>
    j.markers.map((m) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [m.lon, m.lat] },
      properties: { job_id: j.id, workplace_type: j.workplace_type, location_role: m.role },
    })),
  );
  return {
    search_id: "s-1",
    as_of: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    filters: { q: null, region_id: "gta", bbox: [-79.64, 43.58, -79.11, 43.86], time_window: "all", workplace: "all" },
    counts: {
      total: g.in_view.length + g.remote_elsewhere.length + g.location_unverified.length,
      in_view: g.in_view.length,
      remote_elsewhere: g.remote_elsewhere.length,
      location_unverified: g.location_unverified.length,
    },
    groups: {
      in_view: { items: g.in_view, next_cursor: null },
      remote_elsewhere: { items: g.remote_elsewhere, next_cursor: null },
      location_unverified: { items: g.location_unverified, next_cursor: null },
    },
    map: { type: "FeatureCollection", features },
    map_meta: { complete: true, mode: "points", unique_job_count: g.in_view.length, marker_count: features.length },
    warnings: [],
    ...over,
  };
}

export function detail(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: "job-1",
    title: "Backend Engineer",
    company: { name: "Fixture Co", website: null },
    workplace_type: "hybrid",
    status: "active",
    is_open_opportunity: true,
    posted_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    posted_date: null,
    posted_precision: "datetime",
    posted_basis: "original",
    first_seen_at: new Date(Date.now() - 86400_000).toISOString(),
    listed_after: null,
    last_verified_at: new Date(Date.now() - 600_000).toISOString(),
    closed_at: null,
    close_reason: null,
    location_status: "exact_work_location",
    location_label: "Toronto, ON",
    locations: [{
      role: "work_site", address: "1 Test St, Toronto, ON", coordinates: [-79.38, 43.65], precision: "rooftop",
      evidence: { method: "description_explicit_address", excerpt: "Work Location: 1 Test St", source_url: "https://example.test/job", observed_at: null },
    }],
    eligibility: { status: "not_applicable", text: null, regions: [], note: null },
    employment_type: null,
    salary: null,
    description_text: "Plain description <b>not html</b>",
    source: { provider: "greenhouse", board_url: null, job_url: "https://example.test/job", source_updated_at: null, source_republished_at: null, last_seen_at: null },
    sources: [],
    apply_url: "https://example.test/apply",
    ...over,
  };
}
