// temp: node scripts/_view.mjs out.png [lon lat zoom pitch bearing] [w h]
import { chromium } from "@playwright/test";
const [out, lon, lat, z, pitch, bearing, w = "1440", h = "900"] = process.argv.slice(2);
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
p.on("pageerror", (e) => console.log("pageerror:", e.message));
p.on("console", (m) => m.type() === "error" && console.log("console:", m.text().slice(0, 160)));
await p.goto("http://localhost:5174/");
await p.waitForFunction(() => window.__map?.loaded(), null, { timeout: 30000 });
if (lon) await p.evaluate(([a, b, c, d, e]) => window.__map.jumpTo({ center: [+a, +b], zoom: +c, pitch: +d, bearing: +e }), [lon, lat, z, pitch, bearing]);
await p.waitForTimeout(2000);
await p.waitForFunction(() => window.__map.areTilesLoaded(), null, { timeout: 30000 });
await p.waitForTimeout(2500);
await p.screenshot({ path: out });
await b.close();
