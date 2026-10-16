/** Deterministic v2 atlas API for E2E (explicitly synthetic; served only to tests). */
import type { Page, Route } from "@playwright/test";

const CITIES = [
  ["ca-on-toronto", "Toronto", "ON", 43.7, -79.42],
  ["ca-qc-montreal", "Montréal", "QC", 45.51, -73.59],
  ["ca-bc-vancouver", "Vancouver", "BC", 49.25, -123.12],
  ["ca-ab-calgary", "Calgary", "AB", 51.05, -114.07],
  ["ca-ab-edmonton", "Edmonton", "AB", 53.55, -113.49],
  ["ca-mb-winnipeg", "Winnipeg", "MB", 49.9, -97.14],
  ["ca-ns-halifax", "Halifax", "NS", 44.65, -63.58],
  ["ca-nt-yellowknife", "Yellowknife", "NT", 62.45, -114.37],
] as const;
export const HISTORY_START = "2026-07-01";
export const DATA_THROUGH = "2026-09-30";
export const GAP = { start: "2026-08-10", end: "2026-08-12", reason: "fixture gap" };

const day = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const between = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const base: Record<string, number> = { all: 40, bartender: 4, software_development: 6, human_resources: 3 };

function count(city: number, occ: string, d: string): number | null {
  if (CITIES[city]![2] === "NT") return null; // not covered
  const t = between(HISTORY_START, d);
  return Math.round((base[occ] ?? 2) * (8 - city) * (1 + 0.3 * Math.sin(t / 9 + city)));
}

function frame(occ: string, d: string, windowDays: number) {
  const days = Array.from({ length: windowDays }, (_, i) => day(d, -i));
  const inGap = days.some((x) => x >= GAP.start && x <= GAP.end);
  const avail = days.filter((x) => x >= HISTORY_START).length;
  const counts = CITIES.map((_, i) => (inGap ? null : (count(i, occ, d) === null ? null : days.filter((x) => x >= HISTORY_START).reduce((s, x) => s + (count(i, occ, x) ?? 0), 0))));
  return {
    date: d,
    quality: inGap ? "missing" : avail < windowDays ? "partial" : "complete",
    days_available: avail,
    backfilled_days: 0,
    counts,
    national: inGap ? null : counts.reduce<number>((s, c) => s + (c ?? 0), 0),
    notes: inGap ? ["fixture gap"] : [],
  };
}

/** Employer boards (dataset=ats): a parallel dataset with its own range, cities, occupations,
 * hourly releases and backfilled first days (lower bounds). */
export const ATS = {
  start: "2026-09-15",
  through: "2026-09-29",
  backfilled: { start: "2026-09-15", end: "2026-09-18", reason: "backfilled at collection start" },
  employers: 128,
  attribution: "Postings from employers' own career pages via their job-board platforms (fixture).",
  cities: CITIES.filter(([id]) => id !== "ca-nt-yellowknife" && id !== "ca-ns-halifax"),
};
/** Mutable current Employer boards release; an older id answers 404 RELEASE_NOT_FOUND. */
export const atsRelease = { id: "ats1", publishedMinutesAgo: 5 };
const backfilledIn = (days: string[]) => days.filter((x) => x >= ATS.backfilled.start && x <= ATS.backfilled.end).length;

function atsFrame(occ: string, d: string, windowDays: number) {
  const days = Array.from({ length: windowDays }, (_, i) => day(d, -i)).filter((x) => x >= ATS.start);
  const counts = ATS.cities.map((_, i) => days.reduce((s, x) => s + Math.round((base[occ] ?? 2) * (6 - i) * (1 + 0.2 * Math.cos(between(ATS.start, x) / 5 + i))), 0));
  return {
    date: d,
    quality: days.length < windowDays ? "partial" : "complete",
    days_available: days.length,
    backfilled_days: backfilledIn(days),
    counts,
    national: counts.reduce((s, c) => s + c, 0),
    notes: [],
  };
}

async function atsRoute(route: Route, url: URL) {
  const q = url.searchParams;
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const rel = q.get("release");
  if (rel && rel !== atsRelease.id) return json({ error: { code: "RELEASE_NOT_FOUND", message: "release not served" } }, 404);
  const head = { dataset_id: "ats", data_mode: "real", release_id: atsRelease.id };
  if (url.pathname.endsWith("/capabilities"))
    return json({
      ...head, reason: null, metrics: ["new_postings"], windows: ["1d", "7d", "30d"], default_window: "7d", geo_levels: ["city"],
      occupations: [{ id: "all", label: "All jobs", note: "" }, { id: "software_development", label: "Software development", note: "" }, { id: "human_resources", label: "Human resources", note: "" }],
      history_start: ATS.start, data_through: ATS.through, partial_latest_day: false, gaps: [], playback: true, playback_reason: null,
      stale: false, publication: "hourly (fixture)", reporting_timezone: "America/Toronto", quality: {},
      refresh: "hourly", backfilled: [ATS.backfilled], employers: ATS.employers, platforms: ["greenhouse", "lever"], attribution: ATS.attribution,
    });
  if (url.pathname.endsWith("/cities"))
    return json({ ...head, attribution: "GeoNames", cities: ATS.cities.map(([id, name, prov, lat, lon]) => ({ city_id: id, name, province: prov, country: "CA", lat, lon, population: 1, aliases: [], kind: "city", evidence: "fixture" })) });
  if (url.pathname.endsWith("/timeline")) {
    const occ = q.get("occupation") ?? "all";
    const w = { "1d": 1, "7d": 7, "30d": 30 }[q.get("window") ?? "7d"] ?? 7;
    const start = q.get("start")!, end = q.get("end")!;
    return json({
      ...head, metric: "new_postings", occupation: occ, window: q.get("window") ?? "7d", reporting_timezone: "America/Toronto", start, end,
      city_ids: ATS.cities.map((c) => c[0]), frames: Array.from({ length: between(start, end) + 1 }, (_, i) => atsFrame(occ, day(start, i), w)),
      max_count: (base[occ] ?? 2) * 6 * w * 1.3,
    });
  }
  if (url.pathname.endsWith("/frame")) {
    const f = atsFrame(q.get("occupation") ?? "all", q.get("date") ?? ATS.through, { "1d": 1, "7d": 7, "30d": 30 }[q.get("window") ?? "7d"] ?? 7);
    return json({ ...head, backfilled_days: f.backfilled_days, national: { total_unique: f.national, total_reason: null, city_unconfirmed: 3, remote_canada: 0 }, cities: [], notes: [] });
  }
  if (url.pathname.includes("/series")) {
    const end = q.get("end") ?? ATS.through;
    const points = Array.from({ length: between(ATS.start, end) + 1 }, (_, i) => day(ATS.start, i)).map((d, i) => ({
      date: d, count: 20 + i, quality: "complete", backfilled_days: backfilledIn(Array.from({ length: 7 }, (_, k) => day(d, -k))),
    }));
    return json({ ...head, city_id: "x", occupation: "all", window: "7d", points });
  }
  if (url.pathname.endsWith("/version"))
    return json({ ...head, data_through: ATS.through, published_at: new Date(Date.now() - atsRelease.publishedMinutesAgo * 60_000).toISOString(), change_kind: "update" });
  return json({}, 404);
}

/** Mutable published release (tests flip it to simulate a new data version). */
export const release = { id: "fx1", through: DATA_THROUGH_DEFAULT() };
function DATA_THROUGH_DEFAULT() {
  return "2026-09-30";
}

export async function atlasFixture(page: Page, mode: "real" | "not_configured" = "real") {
  await page.route("http://api.fixture/api/v2/atlas/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams;
    if (q.get("dataset") === "ats") return atsRoute(route, url);
    const demo = q.get("dataset") === "demo";
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const dataMode = demo ? "demo" : mode;
    if (url.pathname.endsWith("/capabilities"))
      return json({
        dataset_id: demo ? "demo-v1" : "jobbank", data_mode: dataMode, release_id: dataMode === "not_configured" ? null : release.id,
        reason: dataMode === "not_configured" ? "Real data source is not connected yet (no published release of an admitted source)." : null,
        metrics: ["new_postings"], windows: ["1d", "7d", "30d"], default_window: "7d", geo_levels: ["city"],
        occupations: [
          { id: "all", label: "All jobs", note: "" }, { id: "software_development", label: "Software development", note: "" },
          { id: "human_resources", label: "Human resources", note: "" }, { id: "bartender", label: "Bartender", note: "" },
          { id: "barista", label: "Barista", note: "" },
        ],
        history_start: dataMode === "not_configured" ? null : HISTORY_START,
        data_through: dataMode === "not_configured" ? null : DATA_THROUGH,
        partial_latest_day: false, gaps: dataMode === "not_configured" ? [] : [GAP], playback: dataMode !== "not_configured",
        playback_reason: null, stale: false, publication: "monthly (fixture)", reporting_timezone: "America/Toronto", quality: {},
        refresh: demo ? "on_request" : "monthly", backfilled: [], employers: null, platforms: [],
        attribution: demo ? null : "Contains information licensed under the Open Government Licence – Canada.",
      });
    if (dataMode === "not_configured")
      return json({ error: { code: "DATA_SOURCE_NOT_CONFIGURED", message: "not connected" } }, 503);
    if (url.pathname.endsWith("/cities"))
      return json({
        dataset_id: "jobbank", data_mode: dataMode, release_id: "fx1", attribution: "GeoNames",
        cities: CITIES.map(([id, name, prov, lat, lon]) => ({ city_id: id, name, province: prov, country: "CA", lat, lon, population: 1, aliases: [], kind: "city", evidence: "fixture" })),
      });
    if (url.pathname.endsWith("/timeline")) {
      const occ = q.get("occupation") ?? "all";
      const w = { "1d": 1, "7d": 7, "30d": 30 }[q.get("window") ?? "7d"] ?? 7;
      const start = q.get("start")!;
      const end = q.get("end")!;
      const frames = Array.from({ length: between(start, end) + 1 }, (_, i) => frame(occ, day(start, i), w));
      return json({
        dataset_id: "jobbank", data_mode: dataMode, release_id: "fx1", metric: "new_postings", occupation: occ, window: q.get("window") ?? "7d",
        reporting_timezone: "America/Toronto", start, end, city_ids: CITIES.map((c) => c[0]), frames, max_count: (base[occ] ?? 2) * 8 * w * 1.3,
      });
    }
    if (url.pathname.endsWith("/frame"))
      return json({ backfilled_days: 0, national: { total_unique: 1234, total_reason: null, city_unconfirmed: 12, remote_canada: 3 }, cities: [], notes: [] });
    if (url.pathname.includes("/series")) {
      const end = q.get("end") ?? DATA_THROUGH;
      return json({
        dataset_id: "jobbank", data_mode: dataMode, release_id: "fx1", city_id: "x", occupation: "all", window: "7d",
        points: Array.from({ length: 60 }, (_, i) => ({ date: day(end, i - 59), count: 100 + i, quality: "complete", backfilled_days: 0 })),
      });
    }
    if (url.pathname.endsWith("/version"))
      return json({ dataset_id: "jobbank", data_mode: dataMode, release_id: release.id, data_through: release.through, published_at: "2026-10-02T12:00:00Z", change_kind: "update" });
    if (url.pathname.endsWith("/sources"))
      return json({ sources: [{ key: "jobbank-open-data", provider: "Job Bank open data", status: "approved", admitted: true, reason: "approved with evidence", licence: "OGL", terms_url: "https://open.canada.ca/en/open-government-licence-canada", attribution: "x", capabilities: {}, verified_on: "2026-10-14" }], definitions: { new_postings: "Distinct job postings first published within the window." }, attributions: ["Contains information licensed under the Open Government Licence – Canada."] });
    return json({}, 404);
  });
}
