/* Offline: summarise the real OSM buildings of the GTA into a hexagon grid for the abstract
 * 3D "toy city" layer (src/features/map/cityHexes.ts).
 *
 *   node scripts/build-city-hexes.mjs [../../infra/tiles-data/gta.pmtiles] [public/city-hexes.json]
 *
 * For each hexagon (pointy-top, circumradius SIZE m) it records the building footprint
 * coverage and the area-weighted mean and max height of the buildings whose centre falls in it.
 * Only aggregates leave this script: no building shapes are shipped to the browser.
 * Data © OpenStreetMap contributors (ODbL), via the Protomaps build. */
import { open } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { PMTiles } from "pmtiles";

const [src = "../../infra/tiles-data/gta.pmtiles", out = "public/city-hexes.json"] = process.argv.slice(2);
const Z = 15; // the most detailed level: every building
const BBOX = [-79.95, 43.4, -78.85, 44.1]; // west, south, east, north
const SIZE = 320; // hex circumradius, metres
const ORIGIN = [-79.4, 43.7];
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320 * Math.cos((ORIGIN[1] * Math.PI) / 180);

/** pmtiles Source backed by a local file. */
class LocalSource {
  constructor(fh) { this.fh = fh; }
  getKey() { return src; }
  async getBytes(offset, length) {
    const buf = Buffer.alloc(length);
    await this.fh.read(buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + length) };
  }
}

const lon2x = (lon) => ((lon + 180) / 360) * 2 ** Z;
const lat2y = (lat) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z;
const x2lon = (x) => (x / 2 ** Z) * 360 - 180;
const y2lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** Z))) * 180) / Math.PI;

/** local metres -> axial hex (pointy-top), rounded. */
function hexOf(mx, my) {
  const q = ((Math.sqrt(3) / 3) * mx - (1 / 3) * my) / SIZE;
  const r = ((2 / 3) * my) / SIZE;
  let [x, z] = [q, r];
  let y = -x - z;
  let [rx, ry, rz] = [Math.round(x), Math.round(y), Math.round(z)];
  const [dx, dy, dz] = [Math.abs(rx - x), Math.abs(ry - y), Math.abs(rz - z)];
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy <= dz) rz = -rx - ry;
  return [rx, rz];
}

const fh = await open(src, "r");
const pm = new PMTiles(new LocalSource(fh));
const header = await pm.getHeader();
const x0 = Math.floor(lon2x(BBOX[0]));
const x1 = Math.floor(lon2x(BBOX[2]));
const y0 = Math.floor(lat2y(BBOX[3]));
const y1 = Math.floor(lat2y(BBOX[1]));
const cells = new Map();
let tiles = 0;
let buildings = 0;
const t0 = Date.now();
for (let tx = x0; tx <= x1; tx++) {
  for (let ty = y0; ty <= y1; ty++) {
    const res = await pm.getZxy(Z, tx, ty);
    if (!res) continue;
    tiles++;
    let bytes = new Uint8Array(res.data);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    const layer = new VectorTile(new PbfReader(bytes)).layers.buildings;
    if (!layer) continue;
    const ext = layer.extent;
    // metres per tile unit at this tile's latitude
    const lat = y2lat(ty + 0.5);
    const mPerUnit = (40_075_016 * Math.cos((lat * Math.PI) / 180)) / 2 ** Z / ext;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== 3) continue;
      const rings = f.loadGeometry();
      let area = 0;
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const ring of rings) {
        let a = 0;
        for (let j = 0, k = ring.length - 1; j < ring.length; k = j++) a += (ring[k].x - ring[j].x) * (ring[k].y + ring[j].y);
        area += a / 2; // exterior and holes carry opposite signs
      }
      for (const p of rings[0]) {
        cx += p.x;
        cy += p.y;
        n++;
      }
      area = Math.abs(area) * mPerUnit * mPerUnit;
      if (!n || area < 20) continue;
      const lon = x2lon(tx + cx / n / ext);
      const latc = y2lat(ty + cy / n / ext);
      const mx = (lon - ORIGIN[0]) * M_PER_DEG_LON;
      const my = (latc - ORIGIN[1]) * M_PER_DEG_LAT;
      const key = hexOf(mx, my).join(",");
      const h = Number(f.properties.height) || 7;
      const c = cells.get(key) ?? { area: 0, ah: 0, max: 0 };
      c.area += area;
      c.ah += area * h;
      c.max = Math.max(c.max, h);
      cells.set(key, c);
      buildings++;
    }
  }
}
await fh.close();

const hexArea = ((3 * Math.sqrt(3)) / 2) * SIZE * SIZE;
const rows = [];
for (const [key, c] of cells) {
  const coverage = c.area / hexArea;
  if (coverage < 0.04) continue; // a few sheds in a field: not part of the city
  const [q, r] = key.split(",").map(Number);
  rows.push([q, r, Math.round(c.ah / c.area), Math.round(c.max), Math.round(coverage * 100)]);
}
const { writeFile } = await import("node:fs/promises");
await writeFile(
  out,
  JSON.stringify({
    note: "Aggregated from OpenStreetMap buildings (© OpenStreetMap contributors, ODbL) via Protomaps",
    origin: ORIGIN,
    metresPerDegree: [M_PER_DEG_LON, M_PER_DEG_LAT],
    size: SIZE,
    fields: ["q", "r", "meanHeight", "maxHeight", "coveragePct"],
    cells: rows,
  }),
);
console.log(`${tiles} tiles, ${buildings} buildings -> ${rows.length} hexes in ${((Date.now() - t0) / 1000).toFixed(1)}s (tile minzoom ${header.minZoom}, maxzoom ${header.maxZoom})`);
