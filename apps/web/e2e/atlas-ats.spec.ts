/** Employer boards (dataset=ats) next to Job Bank: the switch, what a switch keeps, backfilled
 * lower bounds, silent hourly updates and expired-release recovery (fixture API). */
import { expect, type Page, test } from "@playwright/test";

import { atlasFixture, atsRelease } from "./atlas-fixture";

test.beforeEach(async ({ page }) => {
  atsRelease.id = "ats1";
  await atlasFixture(page);
});

const ready = (page: Page) => page.waitForFunction(() => (window as unknown as { __atlas?: unknown }).__atlas !== undefined);
const dataset = (page: Page) => page.getByRole("radiogroup", { name: "Dataset" });

test("switch: Job Bank by default, notes from capabilities, keyboard, URL", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const jobBank = dataset(page).getByRole("radio", { name: /Job Bank/ });
  const boards = dataset(page).getByRole("radio", { name: /Employer boards/ });
  await expect(jobBank).toHaveAttribute("aria-checked", "true");
  await expect(dataset(page)).toContainText("All occupations · monthly · since Jul 1, 2026");
  await expect(dataset(page)).toContainText("128 employers' career pages · updated hourly · since Sep 15, 2026");
  // latest mode: Employer boards' own latest day and range (not Job Bank's)
  await boards.click();
  await expect(page).toHaveURL(/data=ats/);
  await expect(page.getByRole("button", { name: "Sep 23–29, 2026" })).toBeVisible();
  expect(await page.getByRole("slider").getAttribute("max")).toBe("14"); // Sep 15 – Sep 29
  // keyboard: arrows move the selection
  await boards.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(jobBank).toHaveAttribute("aria-checked", "true");
  await expect(page).not.toHaveURL(/data=/);
  await expect(page.getByRole("button", { name: "Sep 24–30, 2026" })).toBeVisible();
});

test("history mode keeps a date the other dataset has, otherwise goes latest and says why", async ({ page }) => {
  await page.goto("/?date=2026-08-01");
  await ready(page);
  await dataset(page).getByRole("radio", { name: /Employer boards/ }).click();
  await expect(page.getByText("Employer boards starts Sep 15, 2026")).toBeVisible();
  await expect(page).not.toHaveURL(/date=/);

  await page.goto("/?date=2026-09-22&occupation=bartender");
  await ready(page);
  await dataset(page).getByRole("radio", { name: /Employer boards/ }).click();
  await expect(page).toHaveURL(/date=2026-09-22/);
  await expect(page.getByText("Bartender is not in Employer boards; showing All jobs")).toBeVisible();
  await expect(page.getByRole("button", { name: "Occupation: All jobs" })).toBeVisible();
});

test("a city the other dataset lacks closes its card; one it has stays", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const open = async (name: string) => {
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Search cities" }).click();
    await page.getByRole("button", { name: new RegExp(`^${name},`) }).click();
    await page.keyboard.press("Escape"); // close the list, keep the card
  };
  await open("Toronto");
  await dataset(page).getByRole("radio", { name: /Employer boards/ }).click();
  await expect(page.getByRole("region", { name: "Toronto details" })).toBeVisible();
  await dataset(page).getByRole("radio", { name: /Job Bank/ }).click();
  await open("Halifax");
  await dataset(page).getByRole("radio", { name: /Employer boards/ }).click();
  await expect(page.getByRole("region", { name: "Halifax details" })).toHaveCount(0);
  await expect(page).not.toHaveURL(/city=/);
});

test("backfilled days: timeline shading, lower bounds, no partial notice, dashed trend", async ({ page }) => {
  await page.goto("/?data=ats&date=2026-09-22"); // window Sep 16–22: complete, 3 backfilled days
  await ready(page);
  const mark = page.getByRole("note", { name: /Backfilled from postings still open when collection started — lower bounds/ });
  await expect(mark).toHaveCount(1);
  await mark.focus();
  await expect(page.getByText(/Partial window/)).toHaveCount(0);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Search cities" }).click();
  await page.getByRole("button", { name: /^Toronto,/ }).click();
  const card = page.getByRole("region", { name: "Toronto details" });
  await expect(card.getByText("≈ lower bound")).toBeVisible();
  await expect(card).toContainText("complete within Employer boards data");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Height scale & data" }).click();
  const panel = page.getByRole("region", { name: "Height scale and data" });
  await expect(panel.getByText("≈ lower bound")).toBeVisible();
  await expect(panel).toContainText("Postings from 128 employers' own career pages — mostly tech and corporate. Not the whole job market.");

  // latest day (Sep 23–29, no backfilled day): no lower bound; the trend's early days dashed, later solid
  await page.goto("/?data=ats");
  await ready(page);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Search cities" }).click();
  await page.getByRole("button", { name: /^Toronto,/ }).click();
  const latest = page.getByRole("region", { name: "Toronto details" });
  await expect(latest.getByRole("img", { name: /dashed days are lower bounds/ })).toBeVisible();
  await expect(latest.locator("line[stroke-dasharray]").first()).toBeAttached();
  await expect(latest.locator("line:not([stroke-dasharray])").first()).toBeAttached();
  await expect(latest.getByText("≈ lower bound")).toHaveCount(0);
});

test("hourly releases update silently; history mode keeps only a quiet Latest", async ({ page }) => {
  await page.goto("/?data=ats");
  await ready(page);
  await expect(page.getByText(/Updated 5 min ago/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Sources: Greenhouse · Lever/ })).toBeVisible(); // its platforms
  const caps = page.waitForRequest((r) => r.url().includes("/capabilities") && r.url().includes("dataset=ats"));
  atsRelease.id = "ats2"; // a new hourly release
  await caps; // refetched silently
  await page.waitForTimeout(500);
  await expect(page.getByText(/New data/)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.goto("/?data=ats&date=2026-09-22");
  await ready(page);
  atsRelease.id = "ats3";
  await page.waitForTimeout(2500); // past a version poll
  await expect(page.getByText("New data available.")).toHaveCount(0);
  await page.getByRole("button", { name: "Latest", exact: true }).click();
  await expect(page).not.toHaveURL(/date=/);
});

test("an expired release recovers silently, keeping the map", async ({ page }) => {
  await page.goto("/?data=ats");
  await ready(page);
  atsRelease.id = "ats-new"; // ats1 now answers 404 RELEASE_NOT_FOUND
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Search cities" }).click();
  await page.getByRole("button", { name: /^Toronto,/ }).click(); // series for the old release: 404
  await expect(page.getByRole("region", { name: "Toronto details" }).getByRole("img", { name: /Trend over/ })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __atlas: { bars(): unknown[] } }).__atlas.bars().length)).toBeGreaterThan(0);
});

test("the switch stays short: notes are tooltips and read with each option, no pointer line", async ({ page }) => {
  await page.goto("/?occupation=software_development");
  await ready(page);
  const boards = dataset(page).getByRole("radio", { name: /Employer boards/ });
  await expect(boards).toHaveAttribute("title", "128 employers' career pages · updated hourly · since Sep 15, 2026");
  expect((await dataset(page).boundingBox())!.height).toBeLessThan(40); // one short row on desktop
  await expect(page.getByText(/few tech postings/)).toHaveCount(0);
});

test("phone: the switch fits on one row and is not cut off", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?data=ats");
  await ready(page);
  const group = await dataset(page).boundingBox();
  const more = await page.getByRole("button", { name: "More" }).boundingBox();
  expect(group!.x + group!.width).toBeLessThanOrEqual(more!.x); // clear of the "…" button
  expect(group!.height).toBeLessThan(56); // one row
  expect(group!.x).toBeGreaterThanOrEqual(0); // not cut off
});

test("no WebGL: the 2D map, city list and search work on Employer boards", async ({ page }) => {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type.startsWith("webgl")) return null;
      return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof orig;
  });
  await page.goto("/?data=ats");
  await expect(page.getByRole("img", { name: /2D view/ })).toBeVisible();
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Search cities" }).click();
  await page.getByRole("searchbox", { name: "Search cities" }).fill("calg");
  await page.getByRole("button", { name: /^Calgary,/ }).click();
  await expect(page.getByRole("region", { name: "Calgary details" })).toBeVisible();
});
