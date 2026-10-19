import { expect, test } from "@playwright/test";
import { atlasFixture } from "./atlas-fixture";

test("camera inputs respond immediately and footprints transition independently", async ({ page }) => {
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
    const tween = sc.anim;
    // A burst of wheel events must be applied before yielding to a render frame.
    const wheelErrors: number[] = [];
    for (const factor of [1.01, 1.01, 1.01, 1 / 1.01, 1 / 1.01, 1 / 1.01]) {
      const before = sc.zoom;
      sc.zoomAt(factor, 700, 400, true);
      wheelErrors.push(Math.abs(sc.zoom - before * factor));
    }
    let transitioning = false;
    const started = performance.now();
    while (performance.now() - started < 1800) {
      await new Promise(requestAnimationFrame);
      for (const b of sc.bodies) {
        const v = sc.visual.get(b.id);
        if (v && v.radius > 0 && Math.abs(v.radius - b.radius) > 0.1) transitioning = true;
      }
    }
    const settled = sc.zoom;
    const active = !!sc.raf;
    sc.beginGesture();
    sc.drag(700, 400, 730, 420, true);
    const target = sc.target.clone();
    const dragImmediate = sc.anim === null;
    sc.endGesture();
    await new Promise(resolve => setTimeout(resolve, 700));
    return { initial, immediate, tween, wheelErrors, settled, dragImmediate, transitioning, active, dragError: sc.target.distanceTo(sc.constrain({ ...sc.state(), target }).target) };
  });
  expect(result.immediate).toBeCloseTo(result.initial * 2.25);
  expect(result.tween).toBeNull();
  expect(Math.max(...result.wheelErrors)).toBeLessThan(1e-8);
  expect(result.settled).toBeCloseTo(2.25);
  expect(result.dragImmediate).toBe(true);
  expect(result.transitioning).toBe(true);
  expect(result.active).toBe(false);
  expect(result.dragError).toBeLessThan(0.01);
});
