import { expect, test } from "@playwright/test";
import { atlasFixture } from "./atlas-fixture";

test("camera inputs accumulate and footprints transition before settling", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await atlasFixture(page);
  await page.goto("/");
  await page.waitForFunction(() => {
    const sc = (window as any).__atlas;
    return sc?.visual.size > 0 && !sc.raf;
  });
  const result = await page.evaluate(async () => {
    const sc = (window as any).__atlas;
    const initial = sc.zoom;
    sc.zoomAt(1.5);
    sc.zoomAt(1.5);
    const immediate = sc.zoom;
    const destination = sc.anim.to.zoom;
    // Sample the interpolation deterministically even when software WebGL drops a frame.
    sc.anim.start -= 65;
    sc.stepCamera(performance.now());
    const samples: number[] = [sc.zoom];
    let transitioning = false;
    const started = performance.now();
    while (performance.now() - started < 1800) {
      await new Promise(requestAnimationFrame);
      samples.push(sc.zoom);
      for (const b of sc.bodies) {
        const v = sc.visual.get(b.id);
        if (v && v.radius > 0 && Math.abs(v.radius - b.radius) > 0.1) transitioning = true;
      }
    }
    const settled = sc.zoom;
    const active = !!sc.raf;
    sc.beginGesture();
    sc.drag(700, 400, 730, 420, true);
    const target = sc.anim.to.target.clone();
    sc.endGesture();
    await new Promise(resolve => setTimeout(resolve, 700));
    return { initial, immediate, destination, settled, intermediate: samples.some(z => z > initial && z < destination), transitioning, active, dragError: sc.target.distanceTo(sc.constrain({ ...sc.state(), target }).target) };
  });
  expect(result.immediate).toBe(result.initial);
  expect(result.destination).toBeCloseTo(2.25);
  expect(result.settled).toBeCloseTo(2.25);
  expect(result.intermediate).toBe(true);
  expect(result.transitioning).toBe(true);
  expect(result.active).toBe(false);
  expect(result.dragError).toBeLessThan(0.01);
});
