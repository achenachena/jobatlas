/** Deterministic v2 atlas API for E2E (explicitly synthetic; served only to tests). */
import type { Page, Route } from "@playwright/test";

// id, name, province, lat, lon, group, Job Bank weight, Employer boards weight
export const CITIES = [
  ["ca-on-toronto", "Toronto", "ON", 43.7, -79.42, "cma-535", 8, 6],
  ["ca-qc-montreal", "Montréal", "QC", 45.51, -73.59, "cma-462", 7, 5],
  ["ca-bc-vancouver", "Vancouver", "BC", 49.25, -123.12, "cma-933", 6, 4],
  ["ca-ab-calgary", "Calgary", "AB", 51.05, -114.07, "single-ca-ab-calgary", 5, 3],
  ["ca-ab-edmonton", "Edmonton", "AB", 53.55, -113.49, "single-ca-ab-edmonton", 4, 2],
  ["ca-mb-winnipeg", "Winnipeg", "MB", 49.9, -97.14, "single-ca-mb-winnipeg", 3, 1],
  ["ca-ns-halifax", "Halifax", "NS", 44.65, -63.58, "single-ca-ns-halifax", 2, 0],
  ["ca-nt-yellowknife", "Yellowknife", "NT", 62.45, -114.37, "single-ca-nt-yellowknife", 1, 0],
  ["ca-on-mississauga", "Mississauga", "ON", 43.59, -79.64, "cma-535", 3, 1],
  ["ca-on-brampton", "Brampton", "ON", 43.68, -79.76, "cma-535", 2, 1],
  ["ca-on-vaughan", "Vaughan", "ON", 43.84, -79.5, "cma-535", 2, 1],
  ["ca-on-markham", "Markham", "ON", 43.88, -79.26, "cma-535", 2, 1],
] as const;
/** the largest group weight (the Toronto area), for the region-total scale */
const REGION_WEIGHT = { real: 17, ats: 10 };
export const GROUPS = [
  { id: "cma-535", display_name: "Toronto", official_name: "Toronto", kind: "cma", provinces: ["ON"], lat: 43.7, lon: -79.42 },
  { id: "cma-462", display_name: "Montréal", official_name: "Montréal", kind: "cma", provinces: ["QC"], lat: 45.51, lon: -73.59 },
  { id: "cma-933", display_name: "Vancouver", official_name: "Vancouver", kind: "cma", provinces: ["BC"], lat: 49.25, lon: -123.12 },
  ...CITIES.filter((c) => c[5].startsWith("single")).map(([, name, prov, lat, lon, group]) => ({ id: group, display_name: name, official_name: null, kind: "single", provinces: [prov], lat, lon })),
];
const citiesBody = (list: readonly (typeof CITIES)[number][]) => ({
  attribution: "GeoNames",
  grouping_version: "fx",
  cities: list.map(([id, name, prov, lat, lon, group]) => ({ city_id: id, name, province: prov, country: "CA", lat, lon, population: 1, aliases: [], kind: "city", evidence: "fixture", group_id: group })),
  groups: GROUPS.map((g) => ({ ...g, members: list.filter((c) => c[5] === g.id).length })).filter((g) => g.members),
});
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
  return Math.round((base[occ] ?? 2) * CITIES[city]![6] * (1 + 0.3 * Math.sin(t / 9 + city)));
}

function frame(occ: string, d: string, windowDays: number, allowGap = true) {
  const days = Array.from({ length: windowDays }, (_, i) => day(d, -i));
  const inGap = allowGap && days.some((x) => x >= GAP.start && x <= GAP.end);
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
  cities: CITIES.filter((c) => c[7] > 0),
};
/** Mutable current Employer boards release; an older id answers 404 RELEASE_NOT_FOUND. */
export const atsRelease = { id: "ats1", publishedMinutesAgo: 5 };
const backfilledIn = (days: string[]) => days.filter((x) => x >= ATS.backfilled.start && x <= ATS.backfilled.end).length;

function atsFrame(occ: string, d: string, windowDays: number) {
  const days = Array.from({ length: windowDays }, (_, i) => day(d, -i)).filter((x) => x >= ATS.start);
  const counts = ATS.cities.map((c, i) => days.reduce((s, x) => s + Math.round((base[occ] ?? 2) * c[7] * (1 + 0.2 * Math.cos(between(ATS.start, x) / 5 + i))), 0));
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
      refresh: "hourly", backfilled: [ATS.backfilled], employers: ATS.employers, platforms: ["Greenhouse", "Lever"], attribution: ATS.attribution,
    });
  if (url.pathname.endsWith("/cities"))
    return json({ ...head, ...citiesBody(ATS.cities) });
  if (url.pathname.endsWith("/timeline")) {
    const occ = q.get("occupation") ?? "all";
    const w = { "1d": 1, "7d": 7, "30d": 30 }[q.get("window") ?? "7d"] ?? 7;
    const start = q.get("start")!, end = q.get("end")!;
    return json({
      ...head, metric: "new_postings", occupation: occ, window: q.get("window") ?? "7d", reporting_timezone: "America/Toronto", start, end,
      city_ids: ATS.cities.map((c) => c[0]), frames: Array.from({ length: between(start, end) + 1 }, (_, i) => atsFrame(occ, day(start, i), w)),
      max_count: (base[occ] ?? 2) * REGION_WEIGHT.ats * w * 1.3,
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

/** what /sources attributes on the backend, verbatim */
export const SOURCE_ATTRIBUTIONS = [
  "Contains information licensed under the Open Government Licence – Canada.",
  "City locations: GeoNames (geonames.org), CC BY 4.0.",
  "Map outlines: Natural Earth (public domain).",
  "Adapted from Statistics Canada, 2021 Census – Boundary files, census metropolitan areas and census agglomerations, 2021. This does not constitute an endorsement by Statistics Canada of this product.",
];

/** Mutable published release (tests flip it to simulate a new data version). */
export const release = { id: "fx1", through: DATA_THROUGH_DEFAULT() };
function DATA_THROUGH_DEFAULT() {
  return "2026-09-30";
}

export async function atlasFixture(page: Page, mode: "real" | "not_configured" = "real", overview: "complete" | "gap" | null = null, opts: { sampleEvery?: number } = {}) {
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
        playback_reason: null, stale: false, publication: "monthly (fixture)", reporting_timezone: "America/Toronto", quality: overview ? { scale_max: { all: { "30d": 14000, "7d": 4000 } } } : {},
        refresh: demo ? "on_request" : "monthly", backfilled: [], employers: null, platforms: [],
        attribution: demo ? null : "Contains information licensed under the Open Government Licence – Canada.",
      });
    if (dataMode === "not_configured")
      return json({ error: { code: "DATA_SOURCE_NOT_CONFIGURED", message: "not connected" } }, 503);
    if (url.pathname.endsWith("/cities"))
      return json({ dataset_id: "jobbank", data_mode: dataMode, release_id: "fx1", ...citiesBody(CITIES) });
    if (url.pathname.endsWith("/timeline")) {
      const occ = q.get("occupation") ?? "all";
      const w = { "1d": 1, "7d": 7, "30d": 30 }[q.get("window") ?? "7d"] ?? 7;
      const start = q.get("start")!;
      const end = q.get("end")!;
      const frames = Array.from({ length: between(start, end) + 1 }, (_, i) => frame(occ, day(start, i), w, overview !== "complete"));
      return json({
        dataset_id: "jobbank", data_mode: dataMode, release_id: "fx1", metric: "new_postings", occupation: occ, window: q.get("window") ?? "7d",
        reporting_timezone: "America/Toronto", start, end, city_ids: CITIES.map((c) => c[0]), frames: overview ? frames.map(f => ({...f, national: f.national == null ? null : f.national + 137})) : frames, max_count: (base[occ] ?? 2) * REGION_WEIGHT.real * w * 1.3,
      });
    }
    if (url.pathname.endsWith("/overview")) {
      // The fixture history is short: every day from the first to the last complete window.
      const occ = q.get("occupation") ?? "all";
      const all = Array.from({ length: between(day(HISTORY_START, 29), DATA_THROUGH) + 1 }, (_, i) => frame(occ, day(HISTORY_START, 29 + i), 30, overview !== "complete"))
        .map(f => ({ ...f, national: f.national == null ? null : f.national + 137 }));
      const complete = (f: (typeof all)[number]) => f.quality === "complete";
      const s = all.findIndex(complete), e = all.length - 1 - [...all].reverse().findIndex(complete);
      // sampleEvery: like production, a longer history keeps only some dates (ends included)
      const frames = all.slice(s, e + 1).filter((_, i, list) => !opts.sampleEvery || i % opts.sampleEvery === 0 || i === list.length - 1);
      const incomplete: { start: string; end: string; reason: string }[] = [];
      frames.forEach((f, i) => {
        if (complete(f)) return;
        if (incomplete.length && incomplete.at(-1)!.end === frames[i - 1]?.date) incomplete.at(-1)!.end = f.date;
        else incomplete.push({ start: f.date, end: f.date, reason: "not covered: unknown, not zero" });
      });
      return json({
        format: 1, dataset_id: "jobbank", data_mode: dataMode, release_id: q.get("release") ?? "fx1", occupation: occ, window: "30d",
        start: frames[0]!.date, end: frames.at(-1)!.date, history_start: HISTORY_START, data_through: DATA_THROUGH, scale_max: 14000, samples: 120,
        city_ids: CITIES.map((c) => c[0]), city_max: CITIES.map((_, i) => Math.max(0, ...frames.map(f => f.counts[i] ?? 0))), incomplete, frames,
      });
    }
    if (url.pathname.endsWith("/frame"))
      return json({ backfilled_days: 0, national: { total_unique: 1234, total_reason: null, city_unconfirmed: 12, remote_canada: 3 }, cities: [], notes: [] });
    if (url.pathname.includes("/series")) {
      const end = q.get("end") ?? DATA_THROUGH;
      const occ = q.get("occupation") ?? "all";
      const city = decodeURIComponent(url.pathname.split("/").at(-2)!);
      const i = CITIES.findIndex((c) => c[0] === city);
      const w = { "1d": 1, "7d": 7, "30d": 30 }[q.get("window") ?? "7d"] ?? 7;
      const n = Math.min(Number(q.get("days") ?? 90), between(HISTORY_START, end) + 1);
      return json({
        dataset_id: "jobbank", data_mode: dataMode, release_id: q.get("release") ?? "fx1", city_id: city, occupation: occ, window: q.get("window") ?? "7d",
        points: Array.from({ length: n }, (_, k) => {
          const f = frame(occ, day(end, k - n + 1), w, overview !== "complete");
          return { date: f.date, count: f.counts[i] ?? null, quality: f.quality, backfilled_days: 0 };
        }),
      });
    }
    if (url.pathname.endsWith("/version"))
      return json({ dataset_id: "jobbank", data_mode: dataMode, release_id: release.id, data_through: release.through, published_at: "2026-10-02T12:00:00Z", change_kind: "update" });
    if (url.pathname.endsWith("/sources"))
      return json({ sources: [{ key: "jobbank-open-data", provider: "Job Bank open data", status: "approved", admitted: true, reason: "approved with evidence", licence: "OGL", terms_url: "https://open.canada.ca/en/open-government-licence-canada", attribution: "x", capabilities: {}, verified_on: "2026-10-14" }], definitions: { new_postings: "Distinct job postings first published within the window." }, attributions: SOURCE_ATTRIBUTIONS });
    return json({}, 404);
  });
}
