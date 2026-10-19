import { expect, test } from "vitest";
import { landClearance, separatedRadius } from "./footprints";
const square = (x: number, y: number, size: number): [number, number][][] => [[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]]];
test("footprints respect the rendered country and lakes, but not shared province edges", () => {
  const clearance = landClearance([square(0,0,10), square(10,0,10)], []);
  expect(clearance(10,5)).toBe(5);
  expect(clearance(-1,5)).toBe(0);
  expect(clearance(1,5)).toBe(1);
  const lake = landClearance([square(0,0,20)], [square(8,8,4)]);
  expect(lake(10,10)).toBe(0);
  expect(lake(7,10)).toBe(1);
});
test("body footprints leave room for outline and neighbour separation", () => {
  const r = separatedRadius(100,10,22);
  expect(2 * r * 1.15).toBeLessThan(10);
  expect(separatedRadius(2,100,22) * 1.15).toBeLessThan(2);
  expect(separatedRadius(0,100,22)).toBe(0);
  expect(separatedRadius(100,0,22)).toBe(0);
});

test("indexed clearance matches exact distances across a coastline and lake", () => {
  const outer = square(0, 0, 100), lake = square(40, 40, 20);
  const clearance = landClearance([outer], [lake]);
  for (let x = -7; x <= 107; x += 3) for (let y = -7; y <= 107; y += 3) {
    const outside = x < 0 || x > 100 || y < 0 || y > 100;
    const inLake = x > 40 && x < 60 && y > 40 && y < 60;
    const dx = Math.max(40-x, 0, x-60), dy = Math.max(40-y, 0, y-60);
    const expected = outside || inLake ? 0 : Math.min(x, y, 100-x, 100-y, Math.hypot(dx,dy));
    expect(clearance(x,y)).toBeCloseTo(expected, 8);
    expect(clearance(x,y)).toBeCloseTo(expected, 8); // memoized path must agree
  }
});

test("BVH branch pruning agrees with brute force for many islands", () => {
  const islands = Array.from({length: 20}, (_,i) => square((i%5)*30, Math.floor(i/5)*30, 20));
  const indexed = landClearance(islands, []);
  for (let x=-3; x<150; x+=7) for(let y=-3; y<120; y+=7) {
    const inside = islands.some(p => x>=p[0]![0]![0] && x<=p[0]![2]![0] && y>=p[0]![0]![1] && y<=p[0]![2]![1]);
    let expected = Infinity;
    for(const p of islands) for(let i=0;i<4;i++) {
      const a=p[0]![i]!, b=p[0]![i+1]!;
      const dx=b[0]-a[0],dy=b[1]-a[1];
      const t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)));
      expected=Math.min(expected,Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy));
    }
    expect(indexed(x,y)).toBeCloseTo(inside?expected:0,8);
  }
});
