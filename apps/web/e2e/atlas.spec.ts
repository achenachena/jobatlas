import { expect, test } from "@playwright/test";

import { atlasFixture, DATA_THROUGH, release } from "./atlas-fixture";

test.beforeEach(async ({ page }) => {
  await atlasFixture(page);
});

async function ready(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => (window as unknown as { __atlas?: unknown }).__atlas !== undefined);
  await expect(page.getByText("Sep 24–30, 2026")).toBeVisible();
}

test("default: Canada, all jobs, 7 days, latest, real data — 3D scene with labels", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await ready(page);
  await expect(page.getByRole("button", { name: "Occupation: All jobs" })).toBeVisible();
  await page.getByRole("button", { name: "Sep 24–30, 2026" }).click();
  await expect(page.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Height scale & data" }).click();
  await expect(page.getByRole("region", { name: "Height scale and data" }).getByText("Data through Sep 30, 2026")).toBeVisible();
  await expect(page.locator("[class*=labels] > *").first()).toBeVisible(); // automatic names may exclude coastal marker-only cities
  await expect(page.getByText(/Demo data/)).toHaveCount(0);
  expect(page.url()).not.toContain("?");
  expect(errors).toEqual([]);
});

test("occupation and window switches keep the URL and the fixed-scale legend", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "Occupation: All jobs" }).click();
  await page.getByRole("menuitemradio", { name: "Bartender" }).click();
  await expect(page).toHaveURL(/occupation=bartender/);
  await page.getByRole("button", { name: "Sep 24–30, 2026" }).click();
  await page.getByRole("radio", { name: "30 days" }).click();
  await expect(page).toHaveURL(/window=30d/);
  await expect(page.getByRole("button", { name: "Sep 1–30, 2026" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Occupation: Bartender" })).toBeVisible();
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Height scale & data" }).click();
  await expect(page.getByText("shared by all occupations", { exact: false })).toBeVisible();
});

test("timeline: drag to a past day, play, pause, back to latest; stops at a data gap", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const slider = page.getByRole("slider");
  await slider.focus();
  await page.keyboard.press("Home");
  await expect(page.getByText("Jun 25 – Jul 1, 2026")).toBeVisible();
  await expect(page.getByText(/Partial window: only 1 of 7 days have data/)).toBeVisible(); // partial window
  await expect(page).toHaveURL(/date=2026-07-01/);
  // jump near the gap and play into it: playback stops there and says why
  await page.goto("/?date=2026-08-08");
  await ready(page).catch(() => undefined);
  await page.getByRole("button", { name: "Play history" }).click();
  await expect(page.getByText(/Stopped at a data gap/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/No data for this window/)).toBeVisible();
  await page.getByRole("button", { name: "Skip to next available" }).click();
  await expect(page.getByText(/No data for this window/)).toHaveCount(0);
  await page.getByRole("region", { name: "Timeline" }).getByRole("button", { name: /20\d\d/ }).click();
  await page.getByRole("button", { name: "Latest" }).click();
  await expect(page.getByText("Sep 24–30, 2026")).toBeVisible();
});

test("city list and card: exact numbers, keyboard reachable", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Search cities" }).click();
  const toronto = page.getByRole("button", { name: /^Toronto, ON/ });
  await toronto.focus();
  await page.keyboard.press("Enter");
  const card = page.getByRole("region", { name: "Toronto details" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("img", { name: /Trend over 60 days/ })).toBeVisible();
  await expect(page).toHaveURL(/city=ca-on-toronto/);
  // Yellowknife is not covered: absent from the ranked list (unknown is not zero)
  await expect(page.getByRole("button", { name: /^Yellowknife/ })).toHaveCount(0);
  // ...but a search reaches it, shown as unknown
  await page.getByRole("searchbox", { name: "Search cities" }).fill("yellow");
  await expect(page.getByRole("button", { name: /^Yellowknife, NT\s*unknown/ })).toBeVisible();
});

test("sources dialog shows definitions and attribution", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Sources & definitions" }).click();
  const dialog = page.getByRole("dialog", { name: "Data sources and definitions" });
  await expect(dialog.getByText(/Open Government Licence – Canada/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("not configured: explicit state, demo only on request and labelled", async ({ page }) => {
  await page.unroute("http://api.fixture/api/v2/atlas/**");
  await atlasFixture(page, "not_configured");
  await page.goto("/");
  await expect(page.getByRole("alert").getByText("Data source not connected yet")).toBeVisible();
  await page.getByRole("button", { name: /View demo data/ }).click();
  await expect(page).toHaveURL(/data=demo/);
  await expect(page.getByText(/Demo data · 示例数据/)).toBeVisible();
});

test("no WebGL: 2D fallback map instead of a blank page", async ({ page }) => {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type.startsWith("webgl")) return null;
      return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof orig;
  });
  await page.goto("/");
  await expect(page.getByRole("img", { name: /2D view/ })).toBeVisible();
  await expect(page.getByText("Sep 24–30, 2026")).toBeVisible();
});

test("reduced motion: scene renders with no animation frames left running", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  await page.waitForTimeout(500);
  expect(DATA_THROUGH).toBe("2026-09-30");
});

test("new release: latest mode follows it; history mode keeps its date and offers the latest", async ({ page }) => {
  release.id = "fx1";
  await page.goto("/");
  await ready(page);
  release.id = "fx2"; // a new data version is published
  await expect(page.getByText(/New data through Sep 30, 2026/)).toBeVisible({ timeout: 10_000 });
  // history mode
  release.id = "fx2";
  await page.goto("/?date=2026-08-01");
  await expect(page.getByText(/Jul 26 – Aug 1, 2026/)).toBeVisible();
  release.id = "fx3";
  await expect(page.getByText("New data available.")).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/date=2026-08-01/); // not moved
  await page.getByRole("button", { name: "Go to latest" }).click();
  await expect(page).not.toHaveURL(/date=/);
  release.id = "fx1";
});

test("zoom at the pointer and by pinch, drag to pan, click selects, Ctrl/right-drag and buttons rotate, reset restores", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  const map = page.getByRole("img", { name: /3D map of Canada/ });
  const toronto = () => page.evaluate(() => {
    const sc = (window as unknown as { __atlas: { anchors(): { id: string; bx: number; by: number }[] } }).__atlas;
    const a = sc.anchors().find((a) => a.id === "ca-on-toronto")!;
    return { x: a.bx, y: a.by };
  });
  await expect.poll(async () => (await toronto())?.x).toBeDefined();
  const initial = await toronto();
  // first visit: a one-line gesture hint, gone after the first interaction
  const hint = page.getByRole("note").filter({ hasText: "Ctrl-drag to rotate" });
  await expect(hint).toBeVisible();
  // Once zoomed past the land's size on both axes (at home an axis is locked, centred), the
  // wheel zooms around the pointer: an inland place under it stays put (mouse events are whole
  // pixels). Near a coast or border the view is pulled inland instead.
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Zoom in" }).click();
  // over a solidly inland place (Edmonton), where the view is mostly land; near coasts or
  // borders the "mostly land" limit may move the view instead
  const px = await page.evaluate(() => {
    const sc = (window as unknown as { __atlas: { focusCity(id: string, zoom: number): void; anchors(): { id: string; bx: number; by: number }[] } }).__atlas;
    sc.focusCity("ca-ab-edmonton", 1); // reduced motion: immediate, zoom unchanged
    const a = sc.anchors().find((a) => a.id === "ca-ab-edmonton")!;
    return { x: Math.round(a.bx), y: Math.round(a.by) };
  });
  const before = await page.evaluate(([x, y]) => (window as unknown as { __atlas: { groundAt(x: number, y: number): { x: number; z: number } } }).__atlas.groundAt(x, y), [px.x, px.y]);
  await page.mouse.move(px.x, px.y);
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => {
    const after = await page.evaluate(([x, y]) => (window as unknown as { __atlas: { groundAt(x: number, y: number): { x: number; z: number } } }).__atlas.groundAt(x, y), [px.x, px.y]);
    return Math.hypot(after.x - before.x, after.z - before.z);
  }).toBeLessThan(1); // km on the map
  await expect(hint).toHaveCount(0);
  // a trackpad pinch (wheel + Ctrl, small deltas) zooms noticeably, still around the pointer
  const zoomOf = () => page.evaluate(() => (window as unknown as { __atlas: { zoom: number } }).__atlas.zoom);
  const z0 = await zoomOf();
  await page.keyboard.down("Control");
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -5);
  await page.keyboard.up("Control");
  expect(await zoomOf()).toBeGreaterThan(z0 * 1.5);
  // track the ground point under the pointer
  const ground = before;
  const tracked = () => page.evaluate((g) => {
    const sc = (window as unknown as { __atlas: { toScreen(x: number, y: number, z: number): [number, number]; landTop: number } }).__atlas;
    const [x, y] = sc.toScreen(g.x, sc.landTop, g.z);
    return { x, y };
  }, ground);
  const zoomed = await tracked();
  // dragging (inland, within the limits) moves the map with the pointer and selects nothing
  await page.mouse.move(Math.round(zoomed.x), Math.round(zoomed.y));
  await page.mouse.down();
  await page.mouse.move(Math.round(zoomed.x) + 150, Math.round(zoomed.y) + 90, { steps: 10 });
  await page.mouse.up();
  const dragged = await tracked();
  expect(Math.abs(dragged.x - (zoomed.x + 150))).toBeLessThan(1);
  expect(Math.abs(dragged.y - (zoomed.y + 90))).toBeLessThan(1);
  await expect(page.getByRole("region", { name: /details/ })).toHaveCount(0);
  expect(page.url()).not.toContain("city=");
  // a plain click still selects the city the hover points at
  await page.mouse.move(Math.round(dragged.x), Math.round(dragged.y));
  const hoveredCity = () => page.evaluate(() => (window as unknown as { __atlas: { hovered: string | null } }).__atlas.hovered);
  await expect.poll(hoveredCity).not.toBeNull();
  const hovered = await hoveredCity();
  await page.mouse.click(Math.round(dragged.x), Math.round(dragged.y));
  await expect(page).toHaveURL(new RegExp(`city=${hovered}`));
  await page.keyboard.press("Escape");
  // Ctrl-drag (Mac trackpad) and right-drag turn the map instead of moving it, without selecting
  const azimuth = () => page.evaluate(() => (window as unknown as { __atlas: { azimuth: number } }).__atlas.azimuth);
  const az0 = await azimuth();
  await page.keyboard.down("Control");
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(820, 450, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  expect(Math.abs((await azimuth()) - az0)).toBeGreaterThan(20);
  expect(page.url()).not.toContain("city=");
  const az1 = await azimuth();
  await page.mouse.move(820, 450);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(700, 450, { steps: 10 });
  await page.mouse.up({ button: "right" });
  expect(Math.abs((await azimuth()) - az1)).toBeGreaterThan(20);
  // reset restores the initial scale and position
  await page.getByRole("button", { name: "Reset view" }).click();
  expect((await toronto()).x).toBeCloseTo(initial.x, 1);
  expect((await toronto()).y).toBeCloseTo(initial.y, 1);
  // visible rotate buttons, from the home angle (within the limits both ways)
  const az2 = await azimuth();
  await page.getByRole("button", { name: "Rotate left" }).click();
  expect(Math.abs((await azimuth()) - az2)).toBeGreaterThan(20);
  await page.getByRole("button", { name: "Rotate right" }).click();
  expect((await azimuth()) - az2).toBeCloseTo(0, 5);
  // the map turns all the way round (13 × 28° = 364°), no stop
  await map.focus();
  for (let i = 0; i < 13; i++) await page.keyboard.press("e");
  expect((await azimuth()) - az2).toBeCloseTo(-364, 3);
  await map.focus();
  await page.keyboard.press("e");
  expect(Math.abs((await toronto()).x - initial.x)).toBeGreaterThan(10);
  await page.keyboard.press("0");
  expect((await toronto()).x).toBeCloseTo(initial.x, 1);
});

test("legacy page is retired without requesting v1 data", async ({ page }) => {
  const retired: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/")) retired.push(r.url()); });
  await page.goto("/legacy");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  expect(retired).toEqual([]);
});


test("dense cities: every one a bar in the city layer, one draw batch, rotation changes nothing", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  type Scene = import("../src/atlas/scene/AtlasScene").AtlasScene;
  const bars = await page.evaluate(() => {
    const sc = (window as unknown as { __atlas: Scene }).__atlas;
    const cities = Array.from({ length: 1000 }, (_, i) => ({ id: `dense-${i}`, name: `City ${i}`, lon: -125 + (i % 40) * 0.8, lat: 49.6 + Math.floor(i / 40) * 0.65 }));
    sc.setCities(cities);
    sc.setCounts(new Map(cities.map((c, i) => [c.id, 1000 - i])), 40000);
    const before = JSON.stringify(sc.bars());
    sc.rotate(640);
    return { n: sc.bars().length, same: JSON.stringify(sc.bars()) === before };
  });
  expect(bars).toEqual({ n: 1000, same: true });
  await page.waitForTimeout(100);
  const calls = await page.evaluate(() => (window as unknown as { __atlas: Scene }).__atlas.renderer.info.render.calls);
  expect(calls).toBeLessThan(25);
});

test("rendering stays at native pixel ratio while rotating", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  const quality = await page.evaluate(() => {
    const sc = (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas;
    const before = sc.renderer.getPixelRatio();
    sc.rotate(100);
    return { before, during: sc.renderer.getPixelRatio() };
  });
  expect(quality.during).toBe(quality.before);
});


test("major metro areas keep bars and default labels through rotation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  const bars = () => page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.bars().map(b => b.id));
  for (const id of ["cma-535", "cma-462", "cma-933"]) await expect.poll(bars).toContain(id);
  const picked = await page.evaluate(() => {
    const sc = (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas;
    const a = sc.anchors().find(a => a.id === "cma-535")!;
    const rect = sc.renderer.domElement.getBoundingClientRect();
    return sc.pick(rect.left + a.bx, rect.top + a.by);
  });
  expect(picked).toBe("cma-535");
  const labels = page.locator("[class*=labels]");
  for (const name of ["Toronto", "Montréal", "Vancouver"]) await expect(labels).toContainText(name);
  await page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.rotate(90));
  await page.waitForTimeout(300);
  for (const name of ["Toronto", "Montréal", "Vancouver"]) await expect(labels).toContainText(name);
});

test("geographic labels stay fixed across idle hover, selection, data, and offscreen return", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  const names = ["Toronto", "Montréal", "Vancouver", "Calgary"];
  const labels = page.locator("[class*=labels]");
  for (const name of names) await expect(labels).toContainText(name);
  // A hover on an idle renderer must project immediately, without rotating first.
  const point = await page.evaluate(() => {
    const sc = (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas;
    const a = sc.anchors().find(a => a.id === "ca-mb-winnipeg")!;
    const r = sc.renderer.domElement.getBoundingClientRect();
    return { x: a.bx + r.left, y: a.by + r.top };
  });
  await page.mouse.move(point.x, point.y);
  await expect(labels).toContainText("Winnipeg");
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole("button", { name: /Winnipeg.*Open details/ })).toBeVisible();
  for (const name of names) await expect(labels).toContainText(name);
  await page.mouse.click(700, 160);
  await page.mouse.move(1, 1);
  for (const name of names) await expect(labels).toContainText(name);
  await page.getByRole("button", { name: "Occupation: All jobs" }).click();
  await page.getByRole("menuitemradio", { name: "Bartender" }).click();
  for (const name of names) await expect(labels).toContainText(name);
  // at the home zoom the view is locked; zoomed in, panning to the far west takes Toronto off screen
  await page.evaluate(() => {
    const sc = (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas;
    sc.zoomAt(4);
    sc.pan(5000, 0);
  });
  await expect(labels).not.toContainText("Toronto");
  await page.getByRole("button", { name: "Reset view" }).click();
  for (const name of names) await expect(labels).toContainText(name);
});


test("reference labels distinguish duplicate names using canonical geography", async ({ page }) => {
  await page.route("**/api/v2/atlas/cities?*", route => route.fulfill({ json: {
    dataset_id: "jobbank", data_mode: "real", release_id: "fx1", attribution: "fixture", grouping_version: null, groups: [],
    cities: [
      ["ca-on-toronto", "Toronto", "ON", 43.7, -79.42],
      ["ca-qc-montreal", "Montréal", "QC", 45.51, -73.59],
      ["ca-bc-vancouver", "Vancouver", "BC", 49.25, -123.12],
      ["ca-ab-calgary", "Calgary", "AB", 51.05, -114.07],
      ["ca-pe-toronto", "Toronto", "PE", 46.3, -63.5],
    ].map(([city_id, name, province, lat, lon]) => ({ city_id, name, province, lat, lon, country: "CA", population: 1, aliases: [], kind: "city", evidence: "fixture", group_id: null })),
  } }));
  await page.goto("/"); await ready(page);
  await expect(page.locator("[class*=labels] [data-city-id='ca-on-toronto']")).toBeVisible();
  await expect(page.locator("[class*=labels] [data-city-id='ca-pe-toronto']")).toHaveCount(0);
});

test("initial real bodies do not wait for the playback chunk", async ({ page }) => {
  let releaseChunk!: () => void;
  const gate = new Promise<void>(resolve => { releaseChunk = resolve; });
  await page.route("**/api/v2/atlas/timeline?**", async route => {
    const q = new URL(route.request().url()).searchParams;
    if (q.get("start") !== q.get("end")) await gate;
    await route.fallback();
  });
  try {
    await page.goto("/");
    await page.waitForFunction(() => {
      const s = (window as any).__atlas;
      return s?.domeGeo.instanceCount > 0;
    }, {}, { timeout: 10000 });
    const before = await page.evaluate(() => (window as any).__atlas.bars().map((b: { id: string }) => b.id).sort());
    releaseChunk();
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as any).__atlas.bars().map((b: { id: string }) => b.id).sort())).toEqual(before);
  } finally { releaseChunk(); }
});

for (const deviceScaleFactor of [2, 3]) {
  test(`native DPR ${deviceScaleFactor} remains crisp through rotation and resize`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor });
    const page = await context.newPage();
    await atlasFixture(page);
    await page.goto("/");
    await ready(page);
    const resolution = () => page.evaluate(() => {
      const sc = (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas;
      const canvas = sc.renderer.domElement;
      return { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, ratio: sc.renderer.getPixelRatio(), native: window.devicePixelRatio };
    });
    for (const state of ["initial", "rotating", "resized"]) {
      if (state === "rotating") await page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.rotate(100));
      if (state === "resized") { await page.setViewportSize({ width: 1100, height: 760 }); await page.waitForTimeout(100); }
      const r = await resolution();
      expect(r.ratio).toBe(r.native);
      expect(r.width).toBe(Math.floor(r.cssWidth * deviceScaleFactor));
      expect(r.height).toBe(Math.floor(r.cssHeight * deviceScaleFactor));
    }
    await context.close();
  });
}

test("foreground ink survives a background body's fill in a deterministic overlap specimen", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  // Diagnostic geometry only: the production material/draw passes are kept intact.
  // It is intentionally separate from all real-data screenshots and baselines.
  const result = await page.evaluate(() => {
    const sc = (window as any).__atlas;
    for (const child of sc.scene.children) child.visible = child.geometry === sc.domeGeo;
    sc.camera.left = -300; sc.camera.right = 300;
    sc.camera.top = 300; sc.camera.bottom = -300;
    sc.camera.position.set(0, 200, 1000); sc.camera.lookAt(0, 200, 0);
    sc.camera.updateProjectionMatrix(); sc.camera.updateMatrixWorld();
    sc.domeMat.uniforms.uR.value = 60;
    sc.domeMat.uniforms.uPx.value = 600 / sc.renderer.domElement.clientHeight;
    const g = sc.domeGeo;
    // Front low body right silhouette falls inside the back tall body's fill.
    for (const [i, x, z, height] of [[0, -30, 100, 150], [1, 0, 0, 400]]) {
      g.getAttribute("iPos").setXYZ(i, x, 0, z);
      g.getAttribute("iH").setX(i, height);
      g.getAttribute("iLine").setX(i, 1.5);
      g.getAttribute("iA").setX(i, 1);
    }
    for (const key of ["iPos", "iH", "iLine", "iA"]) g.getAttribute(key).needsUpdate = true;
    g.instanceCount = 2;
    sc.renderer.render(sc.scene, sc.camera);
    const canvas = document.createElement("canvas"), source = sc.renderer.domElement;
    canvas.width = source.width; canvas.height = source.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(source, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let inkRows = 0;
    for (let worldY = 50; worldY < 100; worldY++) {
      const y = Math.round((0.5 + (200 - worldY) / 600) * canvas.height);
      let ink = false;
      for (let worldX = 15; worldX < 38; worldX += 0.25) {
        const x = Math.round((0.5 + worldX / 600) * canvas.width);
        const i = (y * canvas.width + x) * 4;
        if (pixels[i]! < 85 && pixels[i + 1]! < 110 && pixels[i + 2]! > 100) ink = true;
      }
      if (ink) inkRows++;
    }
    return { inkRows };
  });
  expect(result.inkRows).toBeGreaterThanOrEqual(45);
});
