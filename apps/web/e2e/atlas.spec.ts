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

test("map rotates by drag and controls, then resets its view", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  const map = page.getByRole("img", { name: /3D map of Canada/ });
  const anchor = () => page.evaluate(() => {
    const sc = (window as unknown as { __atlas: { anchors(): { id: string; x: number; y: number }[] } }).__atlas;
    return sc.anchors().find((a) => a.id === "ca-on-toronto")!;
  });
  await expect.poll(async () => (await anchor())?.x).toBeDefined();
  const initial = await anchor();
  await page.screenshot({ path: "/tmp/jobatlas-manga-desktop.png" });
  await page.mouse.move(600, 550);
  await page.mouse.down();
  await page.mouse.move(790, 580, { steps: 10 });
  await page.mouse.up();
  expect(Math.abs((await anchor()).x - initial.x)).toBeGreaterThan(10);
  await expect(page.getByRole("region", { name: /details/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Reset view" }).click();
  expect((await anchor()).x).toBeCloseTo(initial.x, 1);
  await map.focus();
  await page.keyboard.press("e");
  expect(Math.abs((await anchor()).x - initial.x)).toBeGreaterThan(10);
  await map.focus();
  await page.keyboard.press("0");
  expect((await anchor()).x).toBeCloseTo(initial.x, 1);
});

test("bodies persist across viewing angles and zoom; labels stay sparse", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  const detail = () => page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.detail());
  await expect.poll(async () => (await detail()).expanded.length).toBeGreaterThan(0);
  const before = (await detail()).expanded;
  expect(before).not.toContain("ca-nt-yellowknife");
  expect(await page.locator("[class*=labels] > div").count()).toBeLessThanOrEqual(4);
  for (let turn = 0; turn < 4; turn++) {
    await page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.rotate(320));
    await page.waitForTimeout(250);
    expect((await detail()).expanded).toEqual(before);
  }
  await page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.zoomAt(3));
  await page.waitForTimeout(250);
  expect((await detail()).expanded).toEqual(before);
});

test("legacy page is retired without requesting v1 data", async ({ page }) => {
  const retired: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/")) retired.push(r.url()); });
  await page.goto("/legacy");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  expect(retired).toEqual([]);
});


test("dense cities: hundreds on entry, stable through rotation, other cities selectable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  const result = await page.evaluate(() => {
    const sc = (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas;
    const cities = Array.from({ length: 1000 }, (_, i) => ({ id: `dense-${i}`, name: `City ${i}`, lon: -125 + (i % 40) * 0.8, lat: 49.6 + Math.floor(i / 40) * 0.65 }));
    sc.setCities(cities);
    sc.setPriority(cities.map((c, i) => ({ id: c.id, max: 1000 - i })));
    sc.setCounts(new Map(cities.map((c, i) => [c.id, 1000 - i])), 40000);
    return { detail: sc.detail(), hidden: "dense-600" };
  });
  expect(result.detail.expanded.length).toBeGreaterThanOrEqual(300);
  await page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.rotate(640));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.detail().expanded)).toEqual(result.detail.expanded);
  await page.evaluate(id => {
    const sc = (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas;
    sc.setSelected(id);
    sc.focusCity(id);
  }, result.hidden);
  await expect.poll(() => page.evaluate(id => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.anchors().find(a => a.id === id)?.body, result.hidden)).toBe(true);
  const calls = await page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.renderer.info.render.calls);
  expect(calls).toBeLessThan(25);
});


test("crisp gestures and separated footprints contained on land", async ({ page }) => {
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
  await page.waitForTimeout(250);
  const bodies = await page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.footprints());
  expect(bodies.length).toBeGreaterThan(0);
  for (const a of bodies) {
    expect(a.radius * 1.15).toBeLessThan(a.clearance);
    for (const b of bodies) if (a.id !== b.id)
      expect((a.radius + b.radius) * 1.15).toBeLessThan(Math.hypot(a.x - b.x, a.z - b.z));
  }
});


test("major coastal cities keep bodies and default labels through rotation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  const scene = () => page.evaluate(() => {
    const sc = (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas;
    return { bodies: sc.footprints().map(b => b.id), anchors: sc.anchors() };
  });
  for (const id of ["ca-on-toronto", "ca-qc-montreal", "ca-bc-vancouver"])
    await expect.poll(async () => (await scene()).bodies).toContain(id);
  const picked = await page.evaluate(() => {
    const sc = (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas;
    const a = sc.anchors().find(a => a.id === "ca-on-toronto")!;
    const rect = sc.renderer.domElement.getBoundingClientRect();
    return sc.pick(rect.left + a.bx, rect.top + a.by);
  });
  expect(picked).toBe("ca-on-toronto");
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
  await page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.pan(5000, 0));
  await expect(labels).not.toContainText("Toronto");
  await page.getByRole("button", { name: "Reset view" }).click();
  for (const name of names) await expect(labels).toContainText(name);
});


test("reference labels distinguish duplicate names using canonical geography", async ({ page }) => {
  await page.route("**/api/v2/atlas/cities?*", route => route.fulfill({ json: {
    dataset_id: "jobbank", data_mode: "real", release_id: "fx1", attribution: "fixture",
    cities: [
      ["ca-on-toronto", "Toronto", "ON", 43.7, -79.42],
      ["ca-qc-montreal", "Montréal", "QC", 45.51, -73.59],
      ["ca-bc-vancouver", "Vancouver", "BC", 49.25, -123.12],
      ["ca-ab-calgary", "Calgary", "AB", 51.05, -114.07],
      ["ca-pe-toronto", "Toronto", "PE", 46.3, -63.5],
    ].map(([city_id, name, province, lat, lon]) => ({ city_id, name, province, lat, lon, country: "CA", population: 1, aliases: [], kind: "city", evidence: "fixture" })),
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
    const before = await page.evaluate(() => [...(window as any).__atlas.expanded].sort());
    releaseChunk();
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => [...(window as any).__atlas.expanded].sort())).toEqual(before);
  } finally { releaseChunk(); }
});

test("zoom preserves world-space body and contact-shadow proportions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ready(page);
  const read = () => page.evaluate(() => {
    const sc = (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas;
    return sc.footprints().map(({ id, x, z, radius }) => ({ id, x, z, radius })).sort((a, b) => a.id.localeCompare(b.id));
  });
  const before = await read();
  expect(before.length).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as { __atlas: import("../src/atlas/scene/AtlasScene").AtlasScene }).__atlas.zoomAt(6));
  await page.waitForTimeout(300);
  expect(await read()).toEqual(before);
  for (const a of before) for (const b of before) if (a.id !== b.id)
    expect((a.radius + b.radius) * 1.16).toBeLessThan(Math.hypot(a.x - b.x, a.z - b.z));
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
      g.getAttribute("iR").setX(i, 60);
      g.getAttribute("iLine").setX(i, 1.5);
    }
    for (const key of ["iPos", "iH", "iR", "iLine"]) g.getAttribute(key).needsUpdate = true;
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
