import { expect, test } from "@playwright/test";

import { mockApi } from "./fixture-api";

test("N: phone layout — filters fold away, results live in a bottom sheet", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByLabel("Posted")).toBeHidden();
  await page.getByRole("button", { name: /Filters/ }).click();
  await expect(page.getByLabel("Posted")).toBeVisible();
  await page.getByRole("button", { name: /Filters/ }).click();
  const handle = page.getByRole("button", { name: /Results \(4\)/ });
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await handle.click();
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
});
