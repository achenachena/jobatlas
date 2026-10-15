/** Short screen recording of the atlas: occupation switches and history playback.
 * node scripts/atlas-record.mjs <out-dir> [query]   (writes a .webm; the page itself shows
 * whether the data is real or demo) */
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const [outDir, query = ""] = process.argv.slice(2);
const base = process.env.ATLAS_URL ?? "http://localhost:5173/";
await fs.mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: outDir, size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();
await page.goto(`${base}${query ? `?${query}` : ""}`);
await page.waitForFunction(() => window.__atlas !== undefined, null, { timeout: 30000 });
await page.waitForTimeout(6000); // buildings rise
for (const name of ["Bartender", "Software dev", "HR", "All jobs"]) {
  await page.getByRole("radio", { name }).click();
  await page.waitForTimeout(2600);
}
// history: jump back a year and play at 4x
await page.goto(`${base}?${query ? `${query}&` : ""}date=2025-09-01`);
await page.waitForFunction(() => window.__atlas !== undefined, null, { timeout: 30000 });
await page.waitForTimeout(5000);
await page.getByRole("combobox", { name: "Playback speed" }).selectOption("4");
await page.getByRole("button", { name: "Play history" }).click();
await page.waitForTimeout(22000);
await page.getByRole("button", { name: "Pause" }).click().catch(() => undefined);
await page.waitForTimeout(1500);
await page.getByRole("button", { name: "Latest" }).click();
await page.waitForTimeout(3000);
const video = page.video();
await ctx.close();
const file = await video.path();
const target = path.join(outDir, query.includes("data=demo") ? "atlas-demo-DEMO-data.webm" : "atlas-demo-real-data.webm");
await fs.rename(file, target);
console.log(target);
await browser.close();
