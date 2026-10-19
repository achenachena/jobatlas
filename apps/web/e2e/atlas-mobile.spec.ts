import { expect, test } from "@playwright/test";

import { atlasFixture } from "./atlas-fixture";

test("phone: map stays visible; controls in rows; city details as a bottom card", async ({ page }) => {
  await atlasFixture(page);
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { __atlas?: unknown }).__atlas !== undefined);
  await expect(page.getByRole("button", { name: "Sep 24–30, 2026", exact: true })).toBeVisible();
  const vp = page.viewportSize()!;
  // the time bar sits at the bottom and leaves most of the screen to the map
  const bar = await page.getByRole("region", { name: "Timeline" }).boundingBox();
  expect(bar!.y + bar!.height).toBeGreaterThan(vp.height - 40);
  expect(bar!.height).toBeLessThan(vp.height * 0.3);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Search cities" }).click();
  await page.getByRole("button", { name: /^Toronto, ON/ }).click();
  const card = await page.getByRole("region", { name: "Toronto details" }).boundingBox();
  expect(card!.width).toBeGreaterThan(vp.width * 0.85); // bottom card, full width
  expect(card!.y).toBeGreaterThan(vp.height * 0.5); // a drawer of at most ~45vh, never the whole map
  // every control is a 44 px touch target
  for (const name of ["Play history", "Reset view", "Zoom in", "Zoom out", "More"]) {
    const b = await page.getByRole("button", { name }).boundingBox();
    expect(b!.width).toBeGreaterThanOrEqual(44);
    expect(b!.height).toBeGreaterThanOrEqual(44);
  }
});
