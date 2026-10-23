import { expect, test } from "@playwright/test";
import { atlasFixture } from "./atlas-fixture";

test("geography renders before the data service responds", async ({ page }) => {
  await atlasFixture(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v2/atlas/capabilities?*", async route => { await pending; await route.fallback(); });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Loading posting data" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__atlas.bodies.length)).toBe(0);
  } finally { release(); }
  await expect.poll(() => page.evaluate(() => (window as any).__atlas.bodies.length)).toBeGreaterThan(0);
});

test("paused startup does not download daily history chunks", async ({ page }) => {
  await atlasFixture(page);
  const ranges: URL[] = [];
  page.on("request", request => { if (request.url().includes("/atlas/timeline?")) ranges.push(new URL(request.url())); });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (window as any).__atlas?.bodies.length ?? 0)).toBeGreaterThan(0);
  expect(ranges.length).toBeGreaterThan(0);
  expect(ranges.every(url => url.searchParams.get("start") === url.searchParams.get("end"))).toBe(true);
});

test("posting requests and geographic preview do not wait for the 3D engine", async ({ page }) => {
  await atlasFixture(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/src/atlas/ui/SceneView.tsx*", async route => { await pending; await route.continue(); });
  try {
    const response = page.waitForResponse(r => r.url().includes("/atlas/timeline?") && r.ok());
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await response;
    await expect(page.getByRole("img", { name: "Map of Canada (interactive view loading)", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Occupation: All jobs" })).toBeVisible();
  } finally { release(); }
  await expect(page.locator("canvas").first()).toBeVisible();
});
