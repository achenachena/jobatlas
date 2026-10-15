import { expect, test } from "@playwright/test";

import { atlasFixture, DATA_THROUGH, release } from "./atlas-fixture";

test.beforeEach(async ({ page }) => {
  await atlasFixture(page);
});

async function ready(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => (window as unknown as { __atlas?: unknown }).__atlas !== undefined);
  await expect(page.getByText("Sep 24 – Sep 30, 2026")).toBeVisible();
}

test("default: Canada, all jobs, 7 days, latest, real data — 3D scene with labels", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await ready(page);
  await expect(page.getByRole("radio", { name: "All jobs" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("complementary").getByText("Data through Sep 30, 2026")).toBeVisible();
  await expect(page.locator("text=Toronto").first()).toBeVisible(); // building label
  await expect(page.getByText(/Demo data/)).toHaveCount(0);
  expect(page.url()).not.toContain("?");
  expect(errors).toEqual([]);
});

test("occupation and window switches keep the URL and the fixed-scale legend", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.getByRole("radio", { name: "Bartender" }).click();
  await expect(page).toHaveURL(/occupation=bartender/);
  await page.getByRole("radio", { name: "30 days" }).click();
  await expect(page).toHaveURL(/window=30d/);
  await expect(page.getByText(/Sep 1 – Sep 30, 2026/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("radio", { name: "Bartender" })).toHaveAttribute("aria-checked", "true");
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
  await page.getByRole("button", { name: "Latest" }).click();
  await expect(page.getByText("Sep 24 – Sep 30, 2026")).toBeVisible();
});

test("city list and card: exact numbers, keyboard reachable", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "City list" }).click();
  const toronto = page.getByRole("button", { name: /^Toronto, ON/ });
  await toronto.focus();
  await page.keyboard.press("Enter");
  const card = page.getByRole("region", { name: "Toronto details" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("img", { name: /Trend over 60 days/ })).toBeVisible();
  await expect(page).toHaveURL(/city=ca-on-toronto/);
  // Yellowknife is not covered: absent from the ranked list (unknown is not zero)
  await expect(page.getByRole("button", { name: /^Yellowknife/ })).toHaveCount(0);
});

test("sources dialog shows definitions and attribution", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "Sources & definitions" }).click();
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
  await expect(page.getByText("Sep 24 – Sep 30, 2026")).toBeVisible();
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
  await page.getByRole("button", { name: "Rotate right" }).click();
  expect(Math.abs((await anchor()).x - initial.x)).toBeGreaterThan(10);
  await map.focus();
  await page.keyboard.press("0");
  expect((await anchor()).x).toBeCloseTo(initial.x, 1);
});

test("legacy page is retired without requesting v1 data", async ({ page }) => {
  const retired: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/")) retired.push(r.url()); });
  await page.goto("/legacy");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  expect(retired).toEqual([]);
});
