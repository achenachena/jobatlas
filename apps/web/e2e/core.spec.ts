import { expect, test } from "@playwright/test";

import { mockApi } from "./fixture-api";

test("A: first visit goes straight to the GTA map with coverage, no login", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator("canvas.maplibregl-canvas")).toBeVisible();
  await expect(page.getByText(/12 employer job boards · updated/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Remote jobs open to: GTA/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Results/ })).toContainText("4");
  await expect(page.getByText(/sign in|log in/i)).toHaveCount(0);
});

test("B: keyword + Past 3 days: request params, consistent map/list counts, excluded-date notice", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Results/ })).toContainText("4");
  await page.getByLabel("Job title or keyword").fill("Backend Engineer");
  await page.getByLabel("Posted").selectOption("3d");
  await expect.poll(() => calls.filter((c) => c.includes("q=Backend+Engineer") && c.includes("time_window=3d")).length).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: /^In this map area/ })).toContainText("2");
  await expect(page.getByText("Current map area · 2")).toBeVisible(); // map label = in-view count
  await expect(page.getByText(/2 matching jobs don't publish a precise enough posting date/)).toBeVisible();
  // the map request always carries the current viewport
  expect(calls.filter((c) => c.startsWith("/api/v1/search")).every((c) => c.includes("bbox="))).toBe(true);
});

test("detail: Apply opens the employer page safely; remote card explains company location", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByText(/company's location|not where you must work/i).first()).toBeVisible();
  await page.getByRole("button", { name: /^Backend Engineer/ }).click();
  const apply = page.getByRole("link", { name: /Apply on employer site/ });
  await expect(apply).toHaveAttribute("href", "https://example.test/apply/j1");
  await expect(apply).toHaveAttribute("target", "_blank");
  await expect(apply).toHaveAttribute("rel", "noopener noreferrer");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("heading", { name: /^In this map area/ })).toBeVisible();
});

test("N: API failure is understandable and recoverable", async ({ page }) => {
  await mockApi(page, { failSearch: true });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("We couldn't load jobs");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("N: keyboard only — search, reach a result, open it", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByLabel("Job title or keyword").focus();
  await page.keyboard.type("Payroll");
  await expect(page.getByRole("heading", { name: /Results/ })).toContainText("1");
  const card = page.getByRole("button", { name: /Payroll Accountant/ });
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Payroll Accountant" })).toBeVisible();
});
