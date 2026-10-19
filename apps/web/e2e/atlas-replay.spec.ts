import { expect, test } from "@playwright/test";
import { atlasFixture } from "./atlas-fixture";

test("ten-second overview uses one frame for map and national numbers, then reveals comparison", async ({ page }) => {
  await page.emulateMedia({reducedMotion:"no-preference"});
  await atlasFixture(page,"real","complete");
  const errors: string[] = [];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/");
  const timeline = page.getByRole("region", { name: "Timeline", exact: true });
  await expect(timeline.getByRole("button", { name: "Watch changes · 10 sec" })).toBeVisible();
  const canvas = await page.locator("canvas").first().boundingBox();
  expect(canvas!.width).toBe(page.viewportSize()!.width);
  const summaryBox = await page.getByRole("complementary", { name: "Postings summary" }).boundingBox();
  expect(summaryBox!.width).toBeLessThan(250);
  await page.getByRole("button",{name:"Watch changes · 10 sec"}).click();
  await expect(page.getByRole("button",{name:"Pause overview"})).toBeVisible({timeout:30000});
  const start=Date.now();
  await page.getByRole("button",{name:"Pause overview"}).click();
  const checked=await page.evaluate(()=>{
    const sc=(window as any).__atlas;
    return {base:sc.comparison.baseline.get("ca-on-toronto"),scale:sc.scaleMax,key:sc.comparison.key};
  });
  expect(checked.base).toBeGreaterThan(0);expect(checked.scale).toBe(14000);
  await expect(page.getByRole("button",{name:"Continue",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(page.getByRole("button",{name:"Replay",exact:true})).toBeVisible({timeout:15000});
  expect(Date.now()-start).toBeGreaterThan(9000);
  expect(Date.now()-start).toBeLessThan(14000);
  await expect(page.getByRole("checkbox",{name:"Compare with start"})).toBeChecked();
  await page.waitForTimeout(1100);
  const numbers=await page.evaluate(()=>{
    const sc=(window as any).__atlas;
    return {sum:sc.bodies.reduce((n:number,b:any)=>n+(b.count??0),0), reveal:sc.compareMat.uniforms.uCompare.value,scale:sc.scaleMax};
  });
  const national=Number((await page.getByTestId("national-total").innerText()).replaceAll(",",""));
  expect(national-numbers.sum).toBe(137);expect(numbers.reveal).toBe(1);expect(numbers.scale).toBe(checked.scale);
  await page.getByRole("button", {name:"More",exact:true}).click();
  await page.getByRole("menuitem", {name:"Height scale & data"}).click();
  await expect(page.getByRole("region", {name:"Height scale and data"})).toContainText(national.toLocaleString("en-CA"));
  await page.getByRole("button", {name:"Close height scale and data"}).click();
  await page.getByRole("checkbox",{name:"Compare with start"}).uncheck();
  await page.getByRole("button",{name:"Occupation: All jobs"}).click();
  await page.getByRole("menuitemradio",{name:"Bartender",exact:true}).click();
  await expect(page.getByRole("checkbox",{name:"Compare with start"})).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("overview stops at unsampled gaps and offers an explicit continuation",async({page})=>{
  await atlasFixture(page,"real","gap");await page.goto("/");
  await page.getByRole("button",{name:"Watch changes · 10 sec"}).click();
  await expect(page.getByRole("button",{name:"Continue to next complete window"})).toBeVisible({timeout:20000});
  await expect(page.getByTestId("national-total")).toHaveText("—");
  await page.getByRole("button",{name:"Continue to next complete window"}).click();
  await expect(page.getByRole("button",{name:"Continue",exact:true})).toBeVisible();
});

test("reduced motion directly shows real endpoint comparison", async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});await atlasFixture(page,"real","complete");await page.goto("/");
  await page.getByRole("button",{name:"Watch changes · 10 sec"}).click();
  await expect(page.getByRole("button",{name:"Replay",exact:true})).toBeVisible();
  await expect(page.getByRole("checkbox",{name:"Compare with start"})).toBeChecked();
});

test("failed preparation can retry, and no-WebGL retains endpoint numbers", async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.addInitScript(() => { const original=HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext=function(kind: string,...args: any[]) { if(kind.includes("webgl")) return null; return original.apply(this,[kind,...args] as any); } as any; });
  await atlasFixture(page,"real","complete");
  let fail=true;
  await page.route("**/api/v2/atlas/timeline?**",async route=>{
    const q=new URL(route.request().url()).searchParams;
    if(fail&&q.get("window")==="30d"&&q.get("start")==="2026-07-30"){ fail=false;return route.fulfill({status:503,json:{error:{message:"History temporarily unavailable"}}}); }
    return route.fallback();
  });
  await page.goto("/");await page.getByRole("button",{name:"Watch changes · 10 sec"}).click();
  await expect(page.getByRole("alert").filter({hasText:"History temporarily unavailable"})).toBeVisible();
  await page.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(page.getByRole("button",{name:"Replay",exact:true})).toBeVisible();
  await expect(page.getByRole("img",{name:/2D view/})).toBeVisible();
  await expect(page.getByTestId("national-change")).not.toContainText("Not comparable");
});

test("mobile summary leaves the timeline accessible and expands remaining cities", async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await atlasFixture(page,"real","complete");await page.goto("/");
  await page.getByRole("button",{name:"Watch changes · 10 sec"}).click();await expect(page.getByRole("button",{name:"Replay",exact:true})).toBeVisible();
  const summary=page.getByRole("complementary",{name:"Postings summary"});
  await expect(summary.getByRole("rowheader",{name:"Calgary"})).toBeHidden();
  await page.getByRole("button",{name:"Show all cities & details"}).click();
  await expect(summary.getByRole("rowheader",{name:"Calgary"})).toBeVisible();
  const box=(await summary.boundingBox())!, timeline=(await page.getByRole("region",{name:"Timeline",exact:true}).boundingBox())!;
  expect(box.y+box.height).toBeLessThanOrEqual(timeline.y);
});

test("date seeking keeps the baseline, backgrounding pauses, and dataset changes clear it", async({page})=>{
  await atlasFixture(page,"real","complete");await page.goto("/");
  await page.getByRole("combobox",{name:"Playback duration"}).selectOption("20");
  await page.getByRole("button",{name:"Watch changes · 20 sec"}).click();
  await expect(page.getByRole("button",{name:"Pause overview"})).toBeVisible();
  await page.evaluate(()=>{Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));});
  await expect(page.getByRole("button",{name:"Continue",exact:true})).toBeVisible();
  await page.evaluate(()=>{Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"));});
  await page.getByRole("slider").press("End");
  await expect(page.getByRole("button",{name:"Sep 1–30, 2026",exact:true})).toBeVisible();
  await page.getByRole("slider").press("Home");
  await expect(page.getByRole("button",{name:"Jul 1–30, 2026",exact:true})).toBeVisible();
  await expect(page.getByTestId("national-change")).toContainText("No change");
  await page.getByRole("radio",{name:/Employer boards/}).click();
  await expect(page.getByRole("checkbox",{name:"Compare with start"})).toHaveCount(0);
  await expect(page.getByRole("region",{name:"Historical overview"})).toHaveCount(0);
});
