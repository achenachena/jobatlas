/** Camera limits under random use: 200 seeded operations per viewport (zoom in/out to the
 * limits at the pointer, drags to the edges, turns and tilts to the limits, keys, city focus),
 * each checked once the camera has settled: zoom floor, home view at zoom 1, no blank margin
 * inside the safe area, capped body height at the deepest zoom, a focused city's whole body on
 * screen. Driven through the scene API with reduced motion, so a settled state is immediate
 * (the same limits a released gesture springs back to); real pointer input is covered in
 * atlas.spec.ts. */
import { expect, test } from "@playwright/test";

import { MAX_HEIGHT } from "../src/atlas/scale";
import { CEL } from "../src/atlas/scene/palette";
import { atlasFixture } from "./atlas-fixture";

for (const vp of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  test(`camera limits hold over 200 random operations (${vp.name} ${vp.width}×${vp.height})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await atlasFixture(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as { __atlas?: unknown }).__atlas !== undefined);
    await page.waitForTimeout(1000);
    const result = await page.evaluate(([maxHeight, homeAz, homeEl, seed]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sc = (window as any).__atlas;
      let s = seed;
      const random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = <T,>(xs: T[]) => xs[Math.floor(random() * xs.length)]!;
      const W = sc.host.clientWidth, H = sc.host.clientHeight;
      const failures: string[] = [];
      let deepest = false;
      for (let op = 0; op < 200; op++) {
        const x = W * (0.15 + 0.7 * random()), y = H * (0.2 + 0.6 * random());
        const kind = pick(["zoomIn", "zoomOut", "zoomMax", "zoomMin", "drag", "dragFar", "rotate", "tilt", "key", "focus"]);
        let focused: string | null = null;
        if (kind === "zoomIn" || kind === "zoomOut") sc.zoomAt(Math.pow(kind === "zoomIn" ? 1.6 : 0.6, 1 + Math.floor(random() * 3)), x, y, true);
        else if (kind === "zoomMax" || kind === "zoomMin") sc.zoomAt(kind === "zoomMax" ? 100 : 0.01, x, y, true);
        else if (kind === "drag" || kind === "dragFar") {
          const [dx, dy] = pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
          for (let i = 0; i < (kind === "dragFar" ? 4 : 1); i++) sc.drag(W / 2, H / 2, W / 2 + dx * W * 0.8, H / 2 + dy * H * 0.7, true);
        } else if (kind === "rotate") sc.rotate((random() < 0.5 ? -1 : 1) * W * 0.6, 0, true);
        else if (kind === "tilt") sc.rotate(0, (random() < 0.5 ? -1 : 1) * H * 0.4, true);
        else if (kind === "key") pick([() => sc.pan(60, 0), () => sc.pan(0, -60), () => sc.zoomAt(1.25), () => sc.zoomAt(0.8), () => sc.rotate(-100), () => sc.rotate(100)])();
        else {
          const ids = sc.detail().expanded as string[];
          focused = ids.length ? ids[Math.floor(random() * ids.length)]! : null;
          if (focused) { sc.setSelected(focused); sc.focusCity(focused); }
        }
        sc.endGesture(); // released: settle inside the limits

        const safe = sc.safeRect();
        const k = sc.worldPerPx();
        const m = sc.camera.matrixWorld.elements as number[];
        const right = [m[0]!, m[1]!, m[2]!], up = [m[4]!, m[5]!, m[6]!];
        const dot = (p: { x: number; y: number; z: number }, a: number[]) => p.x * a[0]! + p.y * a[1]! + p.z * a[2]!;
        const uc = dot(sc.target, right), vc = dot(sc.target, up);
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        // content = the land, plus a selected city's whole body
        const content = [...sc.landPoints];
        const picked = focused ? sc.bodies[sc.byId.get(focused)] : null;
        if (picked && picked.radius > 0)
          for (const py of [sc.landTop, sc.landTop + picked.shown * sc.heightScale()]) content.push({ x: picked.chartX, y: py, z: picked.chartZ });
        for (const p of content) {
          const X = W / 2 + (dot(p, right) - uc) / k, Y = H / 2 - (dot(p, up) - vc) / k;
          x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
        }
        const fail = (msg: string) => failures.push(`#${op} ${kind}: ${msg}`);
        // a) never below the home zoom
        if (sc.zoom < 1 - 1e-6) fail(`a: zoom ${sc.zoom}`);
        // b) zoom 1 at the home angles is exactly the home view
        if (Math.abs(sc.zoom - 1) < 1e-6 && Math.abs(sc.azimuth - homeAz) < 1e-3 && Math.abs(sc.elevation - homeEl) < 1e-3 && !sc.isHome()) fail("b: not the home view");
        // c) zoomed in: on an axis wider than the safe area, the land covers it edge to edge
        if (sc.zoom > 1 + 1e-6) {
          if (x1 - x0 > safe.w && (x0 > safe.x + 0.5 || x1 < safe.x + safe.w - 0.5)) fail(`c: x blank ${x0.toFixed(1)}..${x1.toFixed(1)}`);
          if (y1 - y0 > safe.h && (y0 > safe.y + 0.5 || y1 < safe.y + safe.h - 0.5)) fail(`c: y blank ${y0.toFixed(1)}..${y1.toFixed(1)}`);
        }
        // d) the scaleMax body never projects taller than half the safe height (also at the deepest zoom)
        const maxPx = (maxHeight * sc.heightScale() * Math.cos((sc.elevation * Math.PI) / 180)) / k;
        if (maxPx > safe.h * 0.5 + 0.5) fail(`d: ${maxPx.toFixed(1)}px > ${(safe.h / 2).toFixed(1)}px`);
        if (Math.abs(sc.zoom - 6) < 1e-6) deepest = true;
        // e) a focused city's body is on screen from foot to top
        if (focused) {
          // the body itself (a displaced body stands at its chart position, with a leader)
          const b = sc.bodies[sc.byId.get(focused)];
          if (b.radius > 0 && b.shown > 0) {
            const tip = sc.landTop + b.shown * sc.heightScale();
            const out = [sc.landTop, tip].map((py: number) => sc.toScreen(b.chartX, py, b.chartZ))
              .some(([px, py]: [number, number]) => px < 0 || px > W || py < 0 || py > H);
            if (out) fail(`e: ${focused} body cut`);
          }
          sc.setSelected(null);
        }
      }
      return { failures, deepest };
    }, [MAX_HEIGHT, CEL.azimuth, CEL.elevation, vp.width] as const);
    expect(result.failures).toEqual([]);
    expect(result.deepest).toBe(true); // the deepest zoom was reached and checked (d)
  });
}
