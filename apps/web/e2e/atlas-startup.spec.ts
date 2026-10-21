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
    expect(await page.evaluate(() => (window as any).__atlas.bars().length)).toBe(0);
  } finally { release(); }
  await expect.poll(() => page.evaluate(() => (window as any).__atlas.bars().length)).toBeGreaterThan(0);
});

test("paused startup does not download daily history chunks", async ({ page }) => {
  await atlasFixture(page);
  const ranges: URL[] = [];
  page.on("request", request => { if (request.url().includes("/atlas/timeline?")) ranges.push(new URL(request.url())); });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (window as any).__atlas?.bars().length ?? 0)).toBeGreaterThan(0);
  expect(ranges.length).toBeGreaterThan(0);
  expect(ranges.every(url => url.searchParams.get("start") === url.searchParams.get("end"))).toBe(true);
});
