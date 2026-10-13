/** Geometry for the abstract 3D "toy city" (toyCity.ts). Pure: tested directly.
 *
 * The city is not drawn building by building. public/city-hexes.json (built offline by
 * scripts/build-city-hexes.mjs from the real OSM buildings) gives, per hexagon of the GTA,
 * the building coverage and mean / max height. Each hexagon becomes a toy block:
 *   - a podium: a slightly inset hex prism, low;
 *   - for dense, tall areas a narrower tower on top, in stepped height tiers.
 * Heights are stylised (exaggerated and quantised), only their order follows reality.
 *
 * Vertex format (FLOATS_PER_VERTEX = 8):
 *   x, y, z     position, local metres (x east, y north, z up)
 *   nx, ny      outward wall normal (0, 0 for tops)
 *   v           height above ground (m) — for floor lines
 *   top         height of this prism's top (m)
 *   info        colour index + 100 × kind (kind: 0 podium wall, 1 top face, 2 tower wall)
 */

export const FLOATS_PER_VERTEX = 8;
export const PODIUM_COLOURS = 6; // colour indices 0..5 podiums, 6..8 towers

export interface HexData {
  origin: [number, number];
  metresPerDegree: [number, number];
  size: number;
  cells: Array<[number, number, number, number, number]>; // q, r, meanH, maxH, coverage %
}

export interface ToyBlock {
  lon: number;
  lat: number;
  podium: number; // m
  tower: number; // m, 0 = none
  colour: number;
}

/** Density score -> block: four low podium steps for the ordinary city, and towers only for
 * the densest ~3% (the score threshold sits at the 97th percentile of the GTA's hexagons). */
const PODIUM_STEPS: Array<[number, number]> = [[110, 40], [125, 55], [170, 75], [Infinity, 105]];
const TOWER_SCORE = 264;
const TOWER_TIERS = [400, 600, 850, 1150, 1500, 1900];

export function densityScore(meanH: number, maxH: number, coveragePct: number): number {
  const cov = Math.min(coveragePct / 100, 1);
  return 40 + 9 * meanH + 2.2 * Math.min(maxH, 250) * Math.sqrt(cov);
}

/** Real aggregates -> stylised block heights (metres in the toy world). */
export function stylise(meanH: number, maxH: number, coveragePct: number): { podium: number; tower: number } {
  const score = densityScore(meanH, maxH, coveragePct);
  const podium = PODIUM_STEPS.find(([max]) => score <= max)![1];
  if (score < TOWER_SCORE) return { podium, tower: 0 };
  // the skyline is exaggerated on purpose so the core reads from across the city
  const raw = 300 + (score - TOWER_SCORE) * 4;
  return { podium: 105, tower: TOWER_TIERS.find((t) => raw <= t) ?? TOWER_TIERS.at(-1)! };
}

export function toyBlocks(data: HexData): ToyBlock[] {
  const [lon0, lat0] = data.origin;
  const [mx, my] = data.metresPerDegree;
  return data.cells.map(([q, r, meanH, maxH, cov]) => {
    // axial (pointy-top) -> local metres -> lon/lat
    const x = data.size * Math.sqrt(3) * (q + r / 2);
    const y = data.size * 1.5 * r;
    const { podium, tower } = stylise(meanH, maxH, cov);
    const h = Math.abs(q * 73856093 ^ r * 19349663) % 997;
    // Colour carries meaning: green suburbs, cream city, sakura dense core, glass towers.
    const podiumColour = podium <= 40 ? 3 : podium <= 75 ? 0 : 1;
    return {
      lon: lon0 + x / mx,
      lat: lat0 + y / my,
      podium,
      tower,
      colour: tower ? PODIUM_COLOURS + (h % 3) : podiumColour,
    };
  });
}

/** One hex prism (pointy-top) centred at (cx, cy) with circumradius `radius`. */
function prism(out: number[], cx: number, cy: number, radius: number, bottom: number, top: number,
               colour: number, wallKind: number) {
  const corners: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    corners.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  for (let i = 0; i < 6; i++) {
    const [ax, ay] = corners[i]!;
    const [bx, by] = corners[(i + 1) % 6]!;
    const a = (Math.PI / 180) * (60 * i);
    const [nx, ny] = [Math.cos(a), Math.sin(a)]; // outward: towards the edge midpoint
    const info = 100 * wallKind + colour;
    const v = (x: number, y: number, z: number) => out.push(x, y, z, nx, ny, z, top, info);
    v(ax, ay, bottom); v(bx, by, bottom); v(bx, by, top);
    v(ax, ay, bottom); v(bx, by, top); v(ax, ay, top);
  }
  for (let i = 1; i < 5; i++) {
    for (const [x, y] of [corners[0]!, corners[i]!, corners[i + 1]!]) out.push(x, y, top, 0, 0, top, top, 100 + colour);
  }
}  // prettier-ignore

/** Mesh for all blocks; `toLocal` maps lon/lat to local metres. Built once per load. */
export function buildToyCity(
  blocks: ToyBlock[],
  hexSize: number,
  toLocal: (lon: number, lat: number) => [number, number],
): { data: Float32Array; vertexCount: number } {
  const out: number[] = [];
  for (const b of blocks) {
    const [cx, cy] = toLocal(b.lon, b.lat);
    prism(out, cx, cy, hexSize * 0.9, 0, b.podium, b.tower ? 1 : b.colour, 0);
    if (b.tower) prism(out, cx, cy, hexSize * 0.5, b.podium, b.tower, b.colour, 2);
  }
  return { data: new Float32Array(out), vertexCount: out.length / FLOATS_PER_VERTEX };
}
