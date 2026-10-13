import { buildBuildingMesh, DEFAULT_HEIGHT, FLOATS_PER_VERTEX } from "./buildingMesh";

const identity = (lon: number, lat: number): [number, number] => [lon, lat];

function square(ccw: boolean, props: Record<string, unknown> = { height: 30 }) {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  return { geometry: { type: "Polygon", coordinates: [ccw ? ring : [...ring].reverse()] } as GeoJSON.Polygon, properties: props };
}

function vertices(data: Float32Array) {
  const out = [];
  for (let i = 0; i < data.length; i += FLOATS_PER_VERTEX) out.push(Array.from(data.slice(i, i + FLOATS_PER_VERTEX)));
  return out;
}

test.each([true, false])("walls face outward whatever the ring winding (ccw=%s)", (ccw) => {
  const { data, vertexCount } = buildBuildingMesh([square(ccw)], identity);
  // 4 walls × 6 vertices + roof 2 triangles × 3
  expect(vertexCount).toBe(4 * 6 + 6);
  const walls = vertices(data).filter((v) => v[10]! < 100);
  for (const v of walls) {
    const [x, y, , nx, ny] = v as [number, number, number, number, number];
    // the normal points away from the square's centre (5, 5)
    expect((x - 5) * nx + (y - 5) * ny).toBeGreaterThan(0);
  }
});

test("real heights are used; missing height falls back to a low building", () => {
  const tall = vertices(buildBuildingMesh([square(true, { height: 120, min_height: 20 })], identity).data);
  expect(Math.max(...tall.map((v) => v[2]!))).toBe(120);
  expect(Math.min(...tall.map((v) => v[2]!))).toBe(20);
  const plain = vertices(buildBuildingMesh([square(true, {})], identity).data);
  expect(Math.max(...plain.map((v) => v[2]!))).toBe(DEFAULT_HEIGHT);
});

test("a courtyard (hole) gets inner walls and no roof over the hole", () => {
  const outer = [[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]];
  const hole = [[10, 10], [10, 20], [20, 20], [20, 10], [10, 10]];
  const f = { geometry: { type: "Polygon", coordinates: [outer, hole] } as GeoJSON.Polygon, properties: { height: 12 } };
  const v = vertices(buildBuildingMesh([f], identity).data);
  const roof = v.filter((x) => x[10]! >= 100);
  expect(roof.some((x) => x[0]! > 10.5 && x[0]! < 19.5 && x[1]! > 10.5 && x[1]! < 19.5)).toBe(false);
  // inner walls face into the courtyard (towards its centre 15, 15)
  const inner = v.filter((x) => x[10]! < 100 && x[0]! >= 10 && x[0]! <= 20 && x[1]! >= 10 && x[1]! <= 20);
  expect(inner.length).toBe(4 * 6);
  for (const x of inner) expect((x[0]! - 15) * x[3]! + (x[1]! - 15) * x[4]!).toBeLessThan(0);
});
