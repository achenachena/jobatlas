import { expect, test } from "@playwright/test";
import { atlasFixture } from "./atlas-fixture";

test("occupation menu ranks national counts for the selected window and aligns with the brand", async ({ page }) => {
  await atlasFixture(page, "real", "complete");
  const requests: URL[] = [];
  await page.route("**/api/v2/atlas/frame?**", async route => {
    const url = new URL(route.request().url());
    const occupation = url.searchParams.get("occupation")!;
    if (occupation === "all") return route.fallback();
    requests.push(url);
    const total = ({ barista: 900, bartender: 500, human_resources: 200, software_development: 100 } as Record<string, number>)[occupation];
    await route.fulfill({json:{national:{total_unique:total}}});
  });
  await page.setViewportSize({width:390,height:844});
  await page.goto("/");
  const button = page.getByRole("button", {name:"Occupation: All jobs"});
  await button.click();
  const menu = page.getByRole("menu", {name:"Occupation", exact:true});
  await expect(menu).toContainText("Most postings");
  await expect(menu.getByRole("menuitemradio")).toHaveText(["All jobs", "Barista900", "Bartender500", "Human resources200", "Software development100"]);
  const topmost = await menu.evaluate(el => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.right - 20, box.top + 70));
  });
  expect(topmost).toBe(true);
  expect(requests).toHaveLength(4);
  expect(requests.every(url => url.searchParams.get("window") === "7d" && url.searchParams.get("date") === "2026-09-30" && url.searchParams.get("release") === "fx1")).toBe(true);
  const brand = (await page.getByRole("heading", {name:"JobAtlas"}).boundingBox())!;
  const left = (await button.boundingBox())!.x;
  expect(Math.abs(left - brand.x)).toBeLessThan(2);
  expect((await menu.boundingBox())!.x).toBe(left);
  expect((await page.getByRole("radiogroup", {name:"Dataset"}).boundingBox())!.x).toBe(left);
});
