/** Building geometry for the manga 3D layer (buildings3d.ts). Pure: tested directly.
 *
 * Input: OSM building footprints (GeoJSON Polygon / MultiPolygon in lon/lat) with
 * `height` / `min_height` in metres — the real values from the vector tiles; nothing is moved
 * or invented. Output: one interleaved Float32Array of non-indexed triangles in local metres
 * (x east, y north, z up) around an origin.
 *
 * Per vertex (FLOATS_PER_VERTEX = 11):
 *   x, y, z            position (m)
 *   nx, ny             wall outward normal (0, 0 for roofs)
 *   u, v               wall: distance along the edge (m), height above ground (m)
 *                      roof: local x, y (m)
 *   edgeLen            wall edge length (m)
 *   top, base          wall top / bottom height (m)
 *   info               colour index + 100 × kind (0 wall, 1 roof)
 */
import earcut from "earcut";

export const FLOATS_PER_VERTEX = 11;
export const DEFAULT_HEIGHT = 7; // a footprint without height data: a 2-storey building
export const PALETTE_LOW = 6; // colour indices 0..5: low-rise; 6..8: towers
const TOWER_HEIGHT = 50;

export interface BuildingFeature {
  geometry: GeoJSON.Geometry;
  properties: Record<string, unknown> | null;
}

type Ring = Array<[number, number]>;

function signedArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * (r[j]![1] + r[i]![1]);
  return a / 2; // > 0: counter-clockwise (x east, y north)
}

/** Stable colour pick per building (from its first vertex), towers from their own set. */
function colourIndex(first: [number, number], height: number): number {
  const h = Math.abs(Math.round(first[0] * 7.3 + first[1] * 13.1)) % 97;
  return height >= TOWER_HEIGHT ? PALETTE_LOW + (h % 3) : h % PALETTE_LOW;
}

const num = (v: unknown, fallback: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

export function buildBuildingMesh(
  features: BuildingFeature[],
  toLocal: (lon: number, lat: number) => [number, number],
): { data: Float32Array; vertexCount: number } {
  const out: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, ny: number, u: number, v: number,
                len: number, top: number, base: number, info: number) =>
    out.push(x, y, z, nx, ny, u, v, len, top, base, info);  // prettier-ignore

  for (const f of features) {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    if (polys.length === 0) continue;
    const top = Math.max(num(f.properties?.height, DEFAULT_HEIGHT), 2.5);
    const base = Math.min(Math.max(num(f.properties?.min_height, 0), 0), top - 1);
    for (const poly of polys) {
      const rings: Ring[] = poly
        .filter((ring) => Array.isArray(ring))
        .map((ring) => ring.filter((pos) => Array.isArray(pos) && pos.length >= 2).map(([lon, lat]) => toLocal(lon!, lat!)))
        .map((r) => (r.length > 1 && r[0]![0] === r.at(-1)![0] && r[0]![1] === r.at(-1)![1] ? r.slice(0, -1) : r))
        .filter((r) => r.length >= 3);
      if (rings.length === 0) continue;
      const colour = colourIndex(rings[0]![0]!, top);

      // Walls: a quad per edge, outward normal (outer ring CCW-out, holes the other way).
      rings.forEach((r, ri) => {
        const ccw = signedArea(r) > 0;
        const outwardRight = ri === 0 ? ccw : !ccw; // walking the ring, outside is on the right
        for (let i = 0; i < r.length; i++) {
          const [ax, ay] = r[i]!;
          const [bx, by] = r[(i + 1) % r.length]!;
          const dx = bx - ax;
          const dy = by - ay;
          const len = Math.hypot(dx, dy);
          if (len < 0.05) continue;
          const nx = (outwardRight ? dy : -dy) / len;
          const ny = (outwardRight ? -dx : dx) / len;
          const info = colour;
          push(ax, ay, base, nx, ny, 0, base, len, top, base, info);
          push(bx, by, base, nx, ny, len, base, len, top, base, info);
          push(bx, by, top, nx, ny, len, top, len, top, base, info);
          push(ax, ay, base, nx, ny, 0, base, len, top, base, info);
          push(bx, by, top, nx, ny, len, top, len, top, base, info);
          push(ax, ay, top, nx, ny, 0, top, len, top, base, info);
        }
      });

      // Roof: triangulated footprint (holes kept) at the top.
      const flat: number[] = [];
      const holes: number[] = [];
      rings.forEach((r, ri) => {
        if (ri > 0) holes.push(flat.length / 2);
        for (const [x, y] of r) flat.push(x, y);
      });
      const tris = earcut(flat, holes, 2);
      for (const i of tris) {
        const x = flat[i * 2]!;
        const y = flat[i * 2 + 1]!;
        push(x, y, top, 0, 0, x, y, 0, top, base, 100 + colour);
      }
    }
  }
  return { data: new Float32Array(out), vertexCount: out.length / FLOATS_PER_VERTEX };
}
