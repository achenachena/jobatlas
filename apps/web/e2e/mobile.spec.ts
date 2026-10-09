import { expect, test } from "@playwright/test";

import { mockApi } from "./fixture-api";

test("N: phone layout — map first; filters and list open as bottom sheets on demand", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect(page.getByText("Past 3 days")).toBeHidden();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(page.getByText("Past 3 days")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Past 3 days")).toBeHidden();
  await page.getByRole("button", { name: "View list of 4 jobs" }).click();
  await expect(page.getByRole("heading", { name: /^Results/ })).toBeVisible();
  const expand = page.getByRole("button", { name: "Expand list" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expand.click();
  await expect(page.getByRole("button", { name: "Collapse list" })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: /^Backend Engineer/ }).click();
  await expect(page.getByRole("link", { name: /Apply on employer site/ })).toBeVisible();
});
