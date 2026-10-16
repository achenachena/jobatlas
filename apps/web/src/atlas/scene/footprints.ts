/** Conservative footprint clearance against the actual rendered land, including holes/lakes.
 * Never relocate a city to make a chart fit. Distances use projected map units. */
type Point = [number, number];
type Polygon = Point[][];
function insideRing(x: number, y: number, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
const insidePolygon = (x: number, y: number, p: Polygon) => insideRing(x, y, p[0]!) && !p.slice(1).some(r => insideRing(x, y, r));
export function landClearance(polygons: Polygon[], lakes: Polygon[]) {
  const segments = new Map<string, { a: Point; b: Point; count: number }>();
  for (const p of polygons) for (const r of p) for (let i = 0; i < r.length - 1; i++) {
    const a = r[i]!, b = r[i + 1]!;
    const key = a.join(',') < b.join(',') ? `${a}|${b}` : `${b}|${a}`;
    const old = segments.get(key);
    if (old) old.count++; else segments.set(key, { a, b, count: 1 });
  }
  const edges = [...segments.values()].filter(e => e.count === 1);
  for (const p of lakes) for (const r of p) for (let i = 0; i < r.length - 1; i++) edges.push({ a: r[i]!, b: r[i + 1]!, count: 1 });
  // Exact nearest-edge BVH: avoid testing every coast/lake edge for every candidate.
  type Box = { minX: number; minY: number; maxX: number; maxY: number };
  const bounds = (points: Point[]): Box => ({ minX: Math.min(...points.map(p => p[0])), minY: Math.min(...points.map(p => p[1])), maxX: Math.max(...points.map(p => p[0])), maxY: Math.max(...points.map(p => p[1])) });
  const indexed = (ps: Polygon[]) => ps.map(p => ({ p, ...bounds(p[0]!) }));
  const land = indexed(polygons), water = indexed(lakes);
  const contains = (ps: ReturnType<typeof indexed>, x: number, y: number) => ps.some(b => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && insidePolygon(x, y, b.p));
  type Edge = typeof edges[number];
  type Node = Box & { edges?: Edge[]; left?: Node; right?: Node };
  const tree = (es: Edge[]): Node => {
    const box = bounds(es.flatMap(e => [e.a, e.b]));
    if (es.length <= 12) return { ...box, edges: es };
    const axis = box.maxX - box.minX > box.maxY - box.minY ? 0 : 1;
    es.sort((a, b) => a.a[axis]! + a.b[axis]! - b.a[axis]! - b.b[axis]!);
    const mid = Math.floor(es.length / 2);
    return { ...box, left: tree(es.slice(0, mid)), right: tree(es.slice(mid)) };
  };
  const root = tree(edges);
  const boxDistance = (b: Box, x: number, y: number) => Math.max(b.minX-x, 0, x-b.maxX) ** 2 + Math.max(b.minY-y, 0, y-b.maxY) ** 2;
  const memo = new Map<string, number>();
  return (x: number, y: number): number => {
    const key = `${x},${y}`;
    const known = memo.get(key);
    if (known !== undefined) return known;

    if (!contains(land, x, y) || contains(water, x, y)) { memo.set(key, 0); return 0; }
    let min = Infinity;
    const visit = (node: Node) => {
      if (boxDistance(node, x, y) >= min) return;
      if (node.edges) for (const { a, b } of node.edges) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        min = Math.min(min, (x-a[0]-t*dx) ** 2 + (y-a[1]-t*dy) ** 2);
      } else {
        const a = node.left!, b = node.right!;
        if (boxDistance(a,x,y) <= boxDistance(b,x,y)) { visit(a); visit(b); }
        else { visit(b); visit(a); }
      }
    };
    visit(root);
    const result = Math.sqrt(min);
    memo.set(key, result);
    return result;
  };
}

export function separatedRadius(clearance: number, nearest: number, nominal: number): number {
  return Math.max(0, Math.min(nominal, clearance * 0.7, nearest * 0.32));
}

/** Signed distance to the land's outer edge on a ~8 km raster (km; positive on land, negative
 * off it; lakes count as land), with its gradient, for keeping the camera over land smoothly.
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher). */
export function landField(polygons: Polygon[]) {
  const xs = polygons.flatMap((p) => p[0]!.map((q) => q[0])), ys = polygons.flatMap((p) => p[0]!.map((q) => q[1]));
  const minX = Math.min(...xs) - 400, minY = Math.min(...ys) - 400;
  const cell = 8;
  const w = Math.ceil((Math.max(...xs) + 400 - minX) / cell), h = Math.ceil((Math.max(...ys) + 400 - minY) / cell);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  g.beginPath();
  for (const p of polygons) p[0]!.forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, (x - minX) / cell, (y - minY) / cell));
  g.fill();
  const alpha = g.getImageData(0, 0, w, h).data;
  const land = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) land[i] = alpha[i * 4 + 3]! > 127 ? 1 : 0;
  const INF = 1e20;
  const edt = (feature: (i: number) => boolean) => {
    const d = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) d[i] = feature(i) ? 0 : INF;
    const n = Math.max(w, h), f = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    const pass = (len: number) => {
      let k = 0;
      v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < len; q++) {
        let sx = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
        while (sx <= z[k]!) { k--; sx = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
        k++; v[k] = q; z[k] = sx; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1]! < q) k++;
        out[q] = (q - v[k]!) ** 2 + f[v[k]!]!;
      }
    };
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = d[y * w + x]!;
      pass(h);
      for (let y = 0; y < h; y++) d[y * w + x] = out[y]!;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = d[y * w + x]!;
      pass(w);
      for (let x = 0; x < w; x++) d[y * w + x] = out[x]!;
    }
    return d;
  };
  const toSea = edt((i) => !land[i]), toLand = edt((i) => !!land[i]);
  const sdf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) sdf[i] = land[i] ? Math.sqrt(toSea[i]!) * cell : -Math.sqrt(toLand[i]!) * cell;
  const at = (gx: number, gy: number) => sdf[Math.min(h - 1, Math.max(0, gy)) * w + Math.min(w - 1, Math.max(0, gx))]!;
  // bilinear, so the distance and its gradient change smoothly with position
  const distance = (x: number, y: number) => {
    const fx = (x - minX) / cell - 0.5, fy = (y - minY) / cell - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
  };
  const gradient = (x: number, y: number): Point => [
    (distance(x + cell, y) - distance(x - cell, y)) / (2 * cell),
    (distance(x, y + cell) - distance(x, y - cell)) / (2 * cell),
  ];
  return { distance, gradient };
}
