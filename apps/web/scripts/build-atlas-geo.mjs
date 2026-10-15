/** Build public/atlas/canada-geo.json from Natural Earth (public domain).
 *
 * Canada only (owner decision 2026-10-15): provinces/territories (admin-1, 1:50m) and lakes
 * clipped to Canada (the Great Lakes keep only their Canadian part); no neighbouring land. Projected
 * to a Lambert conformal conic for Canada (Statistics Canada EPSG:3347 parameters: standard
 * parallels 49°N and 77°N, origin 63.390675°N 91.866667°W), in kilometres, simplified
 * (Douglas–Peucker) and with tiny islands dropped. Run: node scripts/build-atlas-geo.mjs
 */
import fs from "node:fs/promises";
import polygonClipping from "polygon-clipping";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.resolve(ROOT, "../../.local/geo");
const OUT = path.join(ROOT, "public/atlas/canada-geo.json");
const NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/";
const FILES = {
  admin1: "ne_50m_admin_1_states_provinces.geojson",
  countries: "ne_50m_admin_0_countries.geojson",
  lakes: "ne_50m_lakes.geojson",
};

// ---------------------------------------------------------------- projection (keep in sync
// with src/atlas/scene/projection.ts)
const R = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
const phi1 = rad(49), phi2 = rad(77), phi0 = rad(63.390675), lam0 = rad(-91.866667);
const n = Math.log(Math.cos(phi1) / Math.cos(phi2)) /
  Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
const F = (Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n)) / n;
const rho = (phi) => R * F / Math.pow(Math.tan(Math.PI / 4 + phi / 2), n);
const rho0 = rho(phi0);
function project([lon, lat]) {
  const r = rho(rad(lat));
  const t = n * (rad(lon) - lam0);
  return [r * Math.sin(t), rho0 - r * Math.cos(t)];
}

// ---------------------------------------------------------------- geometry helpers
function simplify(ring, tol) {
  // A closed ring starts and ends on the same point: simplify its two halves separately.
  if (ring.length < 8) return ring;
  const mid = Math.floor(ring.length / 2);
  return [...simplifyOpen(ring.slice(0, mid + 1), tol), ...simplifyOpen(ring.slice(mid), tol).slice(1)];
}

function simplifyOpen(points, tol) {
  if (points.length < 5) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let best = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / len;
      if (d > best) { best = d; idx = i; }
    }
    if (best > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
const area = (ring) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(s / 2);
};
const round = (ring) => ring.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);

function polygons(geometry) {
  if (!geometry) return [];
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
}

const signedArea = (ring) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return s / 2; // > 0: counter-clockwise (x east, y north)
};
/** Outer rings counter-clockwise, holes clockwise: the extruded top faces upward. */
const orient = (ring, ccw) => ((signedArea(ring) > 0) === ccw ? ring : [...ring].reverse());

function projectFeature(geometry, { tol, minArea, clip }) {
  const out = [];
  for (const poly of polygons(geometry)) {
    // Whole polygons only: dropping points would draw long false edges (e.g. the Aleutians).
    if (clip && poly[0].some(([lon, lat]) => lat < clip.minLat || lon < clip.minLon || lon > clip.maxLon)) continue;
    const rings = poly.filter((ring) => ring.length > 3).map((ring) => simplify(ring.map(project), tol));
    if (!rings.length || rings[0].length < 4 || area(rings[0]) < minArea) continue;
    out.push(
      rings
        .filter((r, i) => i === 0 || (r.length >= 4 && area(r) >= minArea))
        .map((r, i) => round(orient(r, i === 0))),
    );
  }
  return out;
}

async function load(key) {
  await fs.mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, FILES[key]);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    const res = await fetch(NE + FILES[key]);
    if (!res.ok) throw new Error(`${FILES[key]}: ${res.status}`);
    const text = await res.text();
    await fs.writeFile(file, text);
    return JSON.parse(text);
  }
}

const admin1 = await load("admin1");
const lakes = await load("lakes");

const PROVINCE = { "CA-AB": "AB", "CA-BC": "BC", "CA-MB": "MB", "CA-NB": "NB", "CA-NL": "NL", "CA-NS": "NS", "CA-NT": "NT",
  "CA-NU": "NU", "CA-ON": "ON", "CA-PE": "PE", "CA-QC": "QC", "CA-SK": "SK", "CA-YT": "YT" };
const provinces = admin1.features
  .filter((f) => f.properties.adm0_a3 === "CAN")
  .map((f) => ({
    code: PROVINCE[f.properties.iso_3166_2] ?? f.properties.postal,
    name: f.properties.name,
    name_fr: f.properties.name_fr ?? null,
    polygons: projectFeature(f.geometry, { tol: 4, minArea: 900 }),
  }))
  .filter((p) => p.polygons.length);

// Canada only: no neighbouring land. Lakes are clipped to Canada's provinces.
const neighbours = [];
const canada = polygonClipping.union(...provinces.flatMap((p) => p.polygons).map((c) => [c]));
const lakeShapes = lakes.features
  .filter((f) => (f.properties.scalerank ?? 9) <= 2)
  .flatMap((f) => projectFeature(f.geometry, { tol: 3, minArea: 1500 }))
  .flatMap((poly) => {
    const inside = polygonClipping.intersection(poly, canada);
    return inside
      .map((rings) => rings.map((r, i) => round(orient(r, i === 0))))
      .filter((rings) => area(rings[0]) >= 800);
  });

const all = provinces.flatMap((p) => p.polygons.flat(3));
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (let i = 0; i < all.length; i += 2) {
  minX = Math.min(minX, all[i]); maxX = Math.max(maxX, all[i]);
  minY = Math.min(minY, all[i + 1]); maxY = Math.max(maxY, all[i + 1]);
}
const out = {
  source: "Natural Earth 1:50m (public domain): admin-1 provinces of Canada, lakes clipped to Canada",
  projection: { kind: "lcc", lat1: 49, lat2: 77, lat0: 63.390675, lon0: -91.866667, units: "km" },
  bbox: [minX, minY, maxX, maxY].map((v) => Math.round(v)),
  provinces,
  neighbours,
  lakes: lakeShapes,
};
await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify(out));
const size = (await fs.stat(OUT)).size;
console.log(`provinces ${provinces.length}, neighbour polygons ${neighbours.length}, lakes ${lakeShapes.length}, ${Math.round(size / 1024)} KB -> ${path.relative(ROOT, OUT)}`);
