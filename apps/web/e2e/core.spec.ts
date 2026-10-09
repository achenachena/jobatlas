import { expect, test } from "@playwright/test";

import { mockApi } from "./fixture-api";

const listButton = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /^View list of/ });

test("A: first visit goes straight to a full-screen GTA map; no results column, no login", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect(listButton(page)).toHaveAccessibleName("View list of 4 jobs");
  await expect(page.getByRole("button", { name: "Area: GTA" })).toBeVisible();
  // The list and the coverage blurb only appear on demand.
  await expect(page.getByRole("heading", { name: /^In this map area/ })).toHaveCount(0);
  await expect(page.getByText(/employer job boards/)).toHaveCount(0);
  await expect(page.getByText(/sign in|log in/i)).toHaveCount(0);
  // The map fills the viewport.
  const box = await page.locator("canvas.maplibregl-canvas").boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.width * box!.height).toBeGreaterThan(0.95 * vp.width * vp.height);
  await listButton(page).click();
  await expect(page.getByText(/12 employer job boards · updated/)).toBeVisible();
});

test("B: keyword + Past 3 days: request params, consistent map/list counts, excluded-date notice", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/");
  await expect(listButton(page)).toHaveAccessibleName("View list of 4 jobs");
  await page.getByLabel("Job title or keyword").fill("Backend Engineer");
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByText("Past 3 days").click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect.poll(() => calls.filter((c) => c.includes("q=Backend+Engineer") && c.includes("time_window=3d")).length).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Remove filter: Past 3 days" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "in this area" })).toContainText("2"); // map count = in-view
  await listButton(page).click();
  await expect(page.getByRole("heading", { name: /^In this map area/ })).toContainText("2");
  await expect(page.getByText(/2 matching jobs don't publish a precise enough posting date/)).toBeVisible();
  // the map request always carries the current viewport
  expect(calls.filter((c) => c.startsWith("/api/v1/search")).every((c) => c.includes("bbox="))).toBe(true);
});

test("detail: Apply opens the employer page safely; back to list; close restores the map", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await listButton(page).click();
  await expect(page.getByText(/company's location|not where you must work/i).first()).toBeVisible();
  await page.getByRole("button", { name: /^Backend Engineer/ }).click();
  const apply = page.getByRole("link", { name: /Apply on employer site/ });
  await expect(apply).toHaveAttribute("href", "https://example.test/apply/j1");
  await expect(apply).toHaveAttribute("target", "_blank");
  await expect(apply).toHaveAttribute("rel", "noopener noreferrer");
  // one overlay at a time
  await expect(page.getByRole("heading", { name: /^In this map area/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to list" }).click();
  await expect(page.getByRole("heading", { name: /^In this map area/ })).toBeVisible();
  await page.getByRole("button", { name: /^Backend Engineer/ }).click();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(apply).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^In this map area/ })).toHaveCount(0);
});

test("unconfirmed address: reachable from the list, shown without a pin", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await listButton(page).click();
  await page.getByRole("button", { name: /Payroll Accountant/ }).click();
  await expect(page.getByRole("heading", { name: "Payroll Accountant" })).toBeVisible();
  await expect(page.getByText("No map pin: the exact address isn't confirmed yet.")).toBeVisible();
});

test("N: API failure is understandable and recoverable", async ({ page }) => {
  await mockApi(page, { failSearch: true });
  await page.goto("/");
  await expect(page.getByRole("alert").filter({ hasText: "We couldn't load jobs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("N: keyboard only — search, open the list, reach a result, open it, Escape back", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByLabel("Job title or keyword").focus();
  await page.keyboard.type("Payroll");
  await expect(listButton(page)).toHaveAccessibleName("View list of 1 jobs");
  await listButton(page).focus();
  await page.keyboard.press("Enter");
  const card = page.getByRole("button", { name: /Payroll Accountant/ });
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Payroll Accountant" })).toBeVisible();
  await page.keyboard.press("Escape"); // back to the list it came from
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(listButton(page)).toBeFocused();
});
