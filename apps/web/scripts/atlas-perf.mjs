/** Rough, honest performance numbers for the validation report.
 * node scripts/atlas-perf.mjs [swiftshader|gpu] [query]
 * Measures: time to the first frame with buildings; average WebGL render time per frame while
 * panning (120 frames); playback steps actually applied per second at 4x for 10 s. */
import { chromium } from "@playwright/test";

const [mode = "swiftshader", query = ""] = process.argv.slice(2);
const base = process.env.ATLAS_URL ?? "http://localhost:5173/";
const args = mode === "gpu" ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const t0 = Date.now();
await page.goto(`${base}${query ? `?${query}` : ""}`);
await page.waitForFunction(() => window.__atlas?.buildings?.some((b) => b.to > 0), null, { timeout: 60000 });
const firstData = Date.now() - t0;
const info = await page.evaluate(() => {
  const gl = window.__atlas.renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown", cities: window.__atlas.buildings.length };
});
await page.waitForTimeout(2500);
const pan = await page.evaluate(async () => {
  const a = window.__atlas;
  const r = a.renderer;
  const orig = r.render.bind(r);
  const times = [];
  r.render = (s, c) => {
    const t = performance.now();
    orig(s, c);
    r.getContext().finish();
    times.push(performance.now() - t);
  };
  const start = performance.now();
  for (let i = 0; i < 120; i++) {
    a.pan(i % 2 ? 6 : -6, 0);
    await new Promise((res) => requestAnimationFrame(res));
  }
  const wall = performance.now() - start;
  r.render = orig;
  const avg = times.reduce((s, x) => s + x, 0) / Math.max(1, times.length);
  const sorted = [...times].sort((x, y) => x - y);
  return { frames: times.length, avgMs: +avg.toFixed(2), p95Ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2), fps: +((times.length / wall) * 1000).toFixed(1) };
});
// playback 4x for 10 s from one year back
await page.goto(`${base}?${query ? `${query}&` : ""}date=2025-09-01`);
await page.waitForFunction(() => window.__atlas?.buildings?.some((b) => b.to > 0), null, { timeout: 60000 });
await page.waitForTimeout(2000);
await page.getByRole("combobox", { name: "Playback speed" }).selectOption("4");
const before = new URL(page.url()).searchParams.get("date");
await page.getByRole("button", { name: "Play history" }).click();
await page.waitForTimeout(10000);
const after = new URL(page.url()).searchParams.get("date");
await page.getByRole("button", { name: "Pause" }).click().catch(() => undefined);
const days = Math.round((Date.parse(after) - Date.parse(before)) / 86400000);
console.log(JSON.stringify({ mode, query: query || "(real default)", ...info, firstDataMs: firstData, pan, playback4x: { daysIn10s: days, stepsPerSec: +(days / 10).toFixed(2), target: 4 / 0.65 } }));
await browser.close();
