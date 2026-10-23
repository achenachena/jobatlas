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
  await expect.poll(() => page.evaluate(() => (window as any).__atlas.domeMat.uniforms.uCompare.value)).toBe(1);
  const numbers=await page.evaluate(()=>{
    const sc=(window as any).__atlas;
    return {sum:sc.bodies.reduce((n:number,b:any)=>n+(b.count??0),0), reveal:sc.domeMat.uniforms.uCompare.value,scale:sc.scaleMax};
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

test("reduced motion directly shows real endpoint comparison, prepared by one request", async({page})=>{
  const seen: string[] = [];
  page.on("request", request => { const u = new URL(request.url()); if (u.pathname.startsWith("/api/v2/atlas/")) seen.push(u.pathname.split("/").pop()!); });
  await page.emulateMedia({reducedMotion:"reduce"});await atlasFixture(page,"real","complete");await page.goto("/");
  await expect(page.getByRole("button",{name:"Watch changes · 10 sec"})).toBeVisible();
  await page.waitForTimeout(500);
  seen.length = 0;
  await page.getByRole("button",{name:"Watch changes · 10 sec"}).click();
  await expect(page.getByRole("button",{name:"Replay",exact:true})).toBeVisible();
  await expect(page.getByRole("checkbox",{name:"Compare with start"})).toBeChecked();
  // one overview, and no exploration requests competing with it (the version poll is not one)
  expect(seen.filter(p => p !== "version")).toEqual(["overview"]);
  await page.getByRole("combobox", {name:"Playback duration"}).selectOption("daily");
  await page.getByRole("combobox", {name:"Playback duration"}).selectOption("10");
  seen.length = 0;
  await page.getByRole("button", {name:"Watch changes · 10 sec"}).click();
  await expect(page.getByRole("button", {name:"Replay",exact:true})).toBeVisible();
  expect(seen.filter(p => p === "overview")).toEqual([]); // prepared again from memory
});

test("failed preparation can retry, and no-WebGL retains endpoint numbers", async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.addInitScript(() => { const original=HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext=function(kind: string,...args: any[]) { if(kind.includes("webgl")) return null; return original.apply(this,[kind,...args] as any); } as any; });
  await atlasFixture(page,"real","complete");
  let fail=true;
  await page.route("**/api/v2/atlas/overview?**",async route=>{
    if(fail){ fail=false;return route.fulfill({status:503,json:{error:{message:"History temporarily unavailable"}}}); }
    return route.fallback();
  });
  await page.goto("/");await page.getByRole("button",{name:"Watch changes · 10 sec"}).click();
  await expect(page.getByRole("alert").filter({hasText:"History temporarily unavailable"})).toBeVisible();
  await page.getByRole("button",{name:"Retry",exact:true}).click();
  await expect(page.getByRole("button",{name:"Replay",exact:true})).toBeVisible();
  await expect(page.getByRole("img",{name:/2D view/})).toBeVisible();
  await expect(page.getByTestId("national-change")).not.toContainText("Not comparable");
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


test("compact windows keep controls separate and summary collapsed", async ({page}) => {
  await page.emulateMedia({reducedMotion:"reduce"});
  await atlasFixture(page,"real","complete");
  await page.goto("/");
  await page.getByRole("button",{name:"Watch changes · 10 sec"}).click();
  await expect(page.getByRole("button",{name:"Replay",exact:true})).toBeVisible();
  for (const [width,height] of [[1024,768],[820,700],[390,844],[640,390]]) {
    await page.setViewportSize({width:width!,height:height!});
    const summary=page.getByRole("complementary",{name:"Postings summary"});
    await expect(summary.getByRole("table")).toBeHidden();
    const panel=(await summary.boundingBox())!;
    expect(panel.height).toBeLessThan(165);
    expect(panel.y+panel.height).toBeLessThan(height! - 100);
    const timeline=(await page.getByRole("region",{name:"Timeline",exact:true}).boundingBox())!;
    const tools=(await page.getByRole("group",{name:"Map view controls"}).boundingBox())!;
    const overlaps=timeline.x < tools.x+tools.width && timeline.x+timeline.width > tools.x && timeline.y < tools.y+tools.height && timeline.y+timeline.height > tools.y;
    expect(overlaps).toBe(false);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width!);
    await page.getByRole("button",{name:"Show all cities & details"}).click();
    await expect(summary.getByRole("rowheader",{name:"Calgary"})).toBeVisible();
    const expanded = (await summary.boundingBox())!;
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(timeline.y);
    await page.getByRole("button",{name:"Fewer cities"}).click();
  }
});

test("a date between sampled frames shows its own exact frame, fetched on demand", async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});
  await atlasFixture(page,"real","complete",{sampleEvery:10});await page.goto("/");
  await page.getByRole("button",{name:"Watch changes · 10 sec"}).click();
  await expect(page.getByRole("button",{name:"Replay",exact:true})).toBeVisible();
  await page.getByRole("slider").press("Home"); // Jul 30: a sampled date
  await expect(page.getByRole("button",{name:"Jul 1–30, 2026",exact:true})).toBeVisible();
  const asked = page.waitForRequest(r => r.url().includes("/timeline?") && new URL(r.url()).searchParams.get("start") === "2026-07-31" && new URL(r.url()).searchParams.get("end") === "2026-07-31");
  await page.getByRole("slider").press("ArrowRight"); // Jul 31: not in the overview
  await asked;
  const exact = await page.evaluate(async () => (await (await fetch("http://api.fixture/api/v2/atlas/timeline?dataset=real&release=fx1&occupation=all&window=30d&start=2026-07-31&end=2026-07-31")).json()).frames[0].national);
  await expect(page.getByTestId("national-total")).toHaveText(exact.toLocaleString("en-CA"));
  await expect(page.getByRole("button",{name:"Jul 2–31, 2026",exact:true})).toBeVisible();
  await expect(page.getByTestId("national-change")).not.toContainText("Not comparable");
});
