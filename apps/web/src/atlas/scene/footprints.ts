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
