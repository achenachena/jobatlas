/** Two fixed bar layers (city groups zoomed out, cities zoomed in), driven through the scene's
 * API: within a layer nothing about the bars changes with the camera; bars sum to the cities'
 * known counts and stand at their true coordinates; a layer change is a short split or merge. */
import { expect, type Page, test } from "@playwright/test";

import { project } from "../src/atlas/projection";
import { atlasFixture, CITIES, GROUPS } from "./atlas-fixture";

type Bar = { id: string; count: number; x: number; z: number; group: boolean };
/* eslint-disable @typescript-eslint/no-explicit-any */
const scene = (page: Page) => page.evaluate(() => {
  const sc = (window as any).__atlas;
  return { layer: sc.layer() as string, bars: sc.bars() as Bar[], width: (2 * sc.domeMat.uniforms.uR.value) / sc.worldPerPx(), zoom: sc.zoom as number };
});
const truePosition = new Map<string, [number, number]>(
  [...CITIES.map((c) => [c[0], c[4], c[3]] as const), ...GROUPS.map((g) => [g.id, g.lon, g.lat] as const)].map(([id, lon, lat]) => {
    const [x, y] = project(lon, lat);
    return [id, [x, -y]];
  }),
);

for (const [width, height] of [[1440, 900], [390, 844]] as const)
  test.describe(`${width}×${height}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height });
      await atlasFixture(page);
    });

    test("within a layer the camera never changes the bars; sums and positions hold", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.waitForFunction(() => (window as any).__atlas?.bars().length > 0);
      const known = await page.evaluate(() => (window as any).__atlas.cities.reduce((s: number, c: any) => s + (c.count ?? 0), 0));
      for (const layer of ["groups", "cities"]) {
        if (layer === "cities") await page.evaluate(() => (window as any).__atlas.zoomAt(3.4));
        const first = await scene(page);
        expect(first.layer).toBe(layer);
        // (b) the bars add up to every city's known count; (c) each at its true coordinates
        expect(first.bars.reduce((s, b) => s + b.count, 0)).toBe(known);
        for (const b of first.bars) {
          const [x, z] = truePosition.get(b.id)!;
          expect(Math.hypot(b.x - x, b.z - z)).toBeLessThan(1e-6);
        }
        expect(first.bars.some((b) => b.group)).toBe(layer === "groups");
        // (a) random pans, turns and zooms inside the layer keep count, width and ground points
        const ops = await page.evaluate((layer) => {
          const sc = (window as any).__atlas;
          let seed = 7;
          const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
          const seen: string[] = [];
          for (let i = 0; i < 60; i++) {
            const op = Math.floor(rnd() * 3);
            if (op === 0) sc.pan((rnd() - 0.5) * 600, (rnd() - 0.5) * 400);
            else if (op === 1) sc.rotate((rnd() - 0.5) * 800, (rnd() - 0.5) * 100);
            else {
              const lo = layer === "groups" ? 1 : 2.6, hi = layer === "groups" ? 2.9 : 6;
              sc.zoomAt((lo + rnd() * (hi - lo)) / sc.zoom);
            }
            seen.push(JSON.stringify({ layer: sc.layer(), bars: sc.bars(), width: Math.round((2 * sc.domeMat.uniforms.uR.value) / sc.worldPerPx() * 1e6) / 1e6 }));
          }
          return seen;
        }, layer);
        const expected = JSON.stringify({ layer, bars: first.bars, width: 8 });
        expect(ops.filter((o) => o !== expected)).toEqual([]);
        // (d) once the camera stops, nothing is rebuilt
        const drawn = () => page.evaluate(() => {
          const g = (window as any).__atlas.domeGeo;
          return { n: g.instanceCount, pos: Array.from(g.getAttribute("iPos").array.slice(0, g.instanceCount * 3)) };
        });
        await expect.poll(() => page.evaluate(() => (window as any).__atlas.mix)).toBe(layer === "cities" ? 1 : 0);
        await page.evaluate(() => (window as any).__atlas.rotate(40));
        const settled = await drawn();
        await page.waitForTimeout(600);
        expect(await drawn()).toEqual(settled);
        expect((await scene(page)).bars).toEqual(first.bars);
      }
    });

    test("a layer change splits within 300 ms and can reverse mid-way", async ({ page }) => {
      await page.goto("/");
      await page.waitForFunction(() => (window as any).__atlas?.bars().length > 0);
      await page.waitForTimeout(1000); // shaders compiled, first frames done
      // the split runs on the clock: the last frame still mid-way comes within 300 ms (software
      // rendering's long frames only delay when the finished frame is seen)
      const timing = await page.evaluate(() => new Promise<{ ms: number; mid: number; reversed: number }>((resolve) => {
        const sc = (window as any).__atlas;
        const start = performance.now();
        let mid = 0, ms = 0;
        sc.zoomAt(3.4);
        const tick = () => {
          if (sc.mix < 1) {
            if (sc.mix > 0) mid++;
            ms = performance.now() - start;
            return requestAnimationFrame(tick);
          }
          // reverse half-way through a merge: the bars go back from where they are
          sc.zoomAt(1 / 3.4);
          setTimeout(() => {
            const at = sc.mix;
            sc.zoomAt(3.4);
            resolve({ ms, mid, reversed: at });
          }, 120);
        };
        requestAnimationFrame(tick);
      }));
      expect(timing.ms).toBeLessThan(300); // (e)
      expect(timing.mid).toBeGreaterThan(0);
      expect(timing.reversed).toBeGreaterThan(0);
      expect(timing.reversed).toBeLessThan(1);
      await expect.poll(() => page.evaluate(() => (window as any).__atlas.mix)).toBe(1);
    });

    test("reduced motion: a layer change only fades, no bar leaves its position", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.waitForFunction(() => (window as any).__atlas?.bars().length > 0);
      const result = await page.evaluate(() => new Promise<{ frames: number; off: number }>((resolve) => {
        const sc = (window as any).__atlas;
        const spots = [...sc.byId.values()].map((b: any) => [b.x, b.z]);
        let frames = 0, off = 0;
        sc.zoomAt(3.4);
        const tick = () => {
          const g = sc.domeGeo, pos = g.getAttribute("iPos").array;
          for (let i = 0; i < g.instanceCount; i++)
            if (!spots.some(([x, z]) => Math.hypot(pos[i * 3] - x, pos[i * 3 + 2] - z) < 1e-3)) off++;
          frames++;
          if (sc.mix < 1) requestAnimationFrame(tick);
          else resolve({ frames, off });
        };
        requestAnimationFrame(tick);
      }));
      expect(result.frames).toBeGreaterThan(1);
      expect(result.off).toBe(0);
    });

    test("clicking the Toronto area zooms into its cities", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.waitForFunction(() => (window as any).__atlas?.bars().length > 0);
      const point = await page.evaluate(() => {
        const sc = (window as any).__atlas;
        const a = sc.anchors(new Set(["cma-535"]))[0];
        const r = sc.renderer.domElement.getBoundingClientRect();
        return { x: r.left + a.bx, y: r.top + (a.by + a.y) / 2 };
      });
      await page.mouse.click(point.x, point.y);
      await expect.poll(async () => (await scene(page)).layer).toBe("cities");
      const shown = await page.evaluate(() => (window as any).__atlas.anchors(new Set(["ca-on-toronto", "ca-on-mississauga", "ca-on-brampton"])));
      expect(shown.map((a: any) => a.id).sort()).toEqual(["ca-on-brampton", "ca-on-mississauga", "ca-on-toronto"]);
      for (const a of shown) {
        expect(a.body).toBe(true);
        expect(a.bx).toBeGreaterThan(0);
        expect(a.bx).toBeLessThan(width);
        expect(a.y).toBeGreaterThan(0);
        expect(a.by).toBeLessThan(height);
      }
      expect(page.url()).not.toContain("city="); // a group is not a selection
    });
  });

test("labels, group hover note, source line and sources dialog", async ({ page }) => {
  await atlasFixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__atlas?.bars().length > 0);
  const labels = page.locator("[class*=labels]");
  await expect(labels.locator("[data-group-id='cma-535']")).toHaveText(/^Toronto area · [\d,]+$/);
  await expect(labels.locator("[data-group-id='single-ca-ab-calgary']")).toHaveCount(0); // a city alone is the city
  await expect(labels.locator("[data-city-id='ca-ab-calgary']")).toHaveText(/^Calgary · [\d,]+$/);
  const point = await page.evaluate(() => {
    const sc = (window as any).__atlas;
    const a = sc.anchors(new Set(["cma-535"]))[0];
    const r = sc.renderer.domElement.getBoundingClientRect();
    return { x: r.left + a.bx, y: r.top + (a.by + a.y) / 2 };
  });
  await page.mouse.move(point.x, point.y);
  const note = labels.locator("[data-group-id='cma-535']").last();
  await expect(note).toContainText("Toronto, ON");
  await expect(note).toContainText("5 cities with postings");
  await expect(note).not.toContainText("Statistics Canada:"); // same as the shown name
  const sources = page.getByRole("button", { name: "Sources: Job Bank · Statistics Canada · GeoNames · Natural Earth" });
  await sources.click();
  const dialog = page.getByRole("dialog", { name: "Data sources and definitions" });
  await expect(dialog).toContainText("This does not constitute an endorsement by Statistics Canada of this product.");
  await expect(dialog).toContainText("City locations: GeoNames (geonames.org), CC BY 4.0.");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Height scale & data" }).click();
  await expect(page.getByRole("region", { name: "Height scale and data" })).toContainText("On the map: cities only · + 15 remote or city unconfirmed");
});
