/** Screenshots of the atlas for review and delivery.
 * node scripts/atlas-shots.mjs <out.png> [query] [width] [height] [--mobile] [--click=x,y] [--wait=ms] [--focus=cityId:zoom]
 * Example: node scripts/atlas-shots.mjs /tmp/a.png "occupation=bartender" 1440 900 */
import { chromium, devices } from "@playwright/test";

const [out, query = "", w = "1440", h = "900", ...flags] = process.argv.slice(2);
const base = process.env.ATLAS_URL ?? "http://localhost:5173/";
const mobile = flags.includes("--mobile");
const wait = Number((flags.find((f) => f.startsWith("--wait=")) ?? "--wait=2500").slice(7));
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext(mobile ? { ...devices["iPhone 13"] } : { viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text().slice(0, 200)}`));
await page.goto(`${base}${query ? `?${query}` : ""}`);
await page.waitForFunction(() => window.__atlas !== undefined, null, { timeout: 30000 }).catch(() => errors.push("scene not created"));
await page.waitForTimeout(wait);
const focus = flags.find((f) => f.startsWith("--focus="));
if (focus) {
  const [id, zoom] = focus.slice(8).split(":");
  await page.evaluate(([cid, z]) => window.__atlas.focusCity(cid, Number(z || 5)), [id, zoom]);
  await page.waitForTimeout(1500);
}
for (const f of flags.filter((f) => f.startsWith("--click="))) {
  const [x, y] = f.slice(8).split(",").map(Number);
  await page.mouse.click(x, y);
  await page.waitForTimeout(1200);
}
await page.screenshot({ path: out });
if (errors.length) console.log(errors.join("\n"));
await browser.close();
