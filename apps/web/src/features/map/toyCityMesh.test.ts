import { squashFor } from "./toyCity";
import { buildToyCity, FLOATS_PER_VERTEX, type HexData, stylise, toyBlocks } from "./toyCityMesh";

const local = (lon: number, lat: number): [number, number] => [lon * 1000, lat * 1000];

test("denser, taller areas become taller blocks; suburbs stay low podiums", () => {
  const suburb = stylise(7, 12, 20);
  const midtown = stylise(20, 60, 35);
  const downtown = stylise(80, 250, 55);
  expect(suburb.tower).toBe(0);
  expect(downtown.tower).toBeGreaterThan(midtown.tower || midtown.podium);
  expect(midtown.podium).toBeGreaterThanOrEqual(suburb.podium);
});

test("each block is a hex prism (6 walls + 4 top triangles), towers add a second prism", () => {
  const prism = 6 * 6 + 4 * 3;
  const one = buildToyCity([{ lon: 0, lat: 0, podium: 60, tower: 0, colour: 1 }], 100, local);
  expect(one.vertexCount).toBe(prism);
  const two = buildToyCity([{ lon: 0, lat: 0, podium: 60, tower: 400, colour: 7 }], 100, local);
  expect(two.vertexCount).toBe(2 * prism);
  const zs = [];
  for (let i = 2; i < two.data.length; i += FLOATS_PER_VERTEX) zs.push(two.data[i]!);
  expect(Math.max(...zs)).toBe(400);
});

test("walls face outward from the hex centre", () => {
  const { data } = buildToyCity([{ lon: 0, lat: 0, podium: 60, tower: 0, colour: 0 }], 100, local);
  for (let i = 0; i < data.length; i += FLOATS_PER_VERTEX) {
    const [x, y, , nx, ny] = data.slice(i, i + 5);
    if (nx === 0 && ny === 0) continue; // top face
    expect(x! * nx! + y! * ny!).toBeGreaterThan(0);
  }
});

test("hex grid positions come from axial coordinates around the origin", () => {
  const data: HexData = { origin: [-79.4, 43.7], metresPerDegree: [80000, 110000], size: 320,
    cells: [[0, 0, 7, 10, 20], [1, 0, 7, 10, 20]] };  // prettier-ignore
  const [a, b] = toyBlocks(data);
  expect(a!.lon).toBeCloseTo(-79.4);
  expect((b!.lon - a!.lon) * 80000).toBeCloseTo(320 * Math.sqrt(3));
  expect(b!.lat).toBeCloseTo(a!.lat);
});

test("the toy city stands at city scale and is gone at street scale", () => {
  expect(squashFor(11)).toBe(1);
  expect(squashFor(13.1)).toBeGreaterThan(0);
  expect(squashFor(13.1)).toBeLessThan(1);
  expect(squashFor(14.5)).toBe(0);
});
