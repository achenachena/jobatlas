/* Real-browser screenshots of the running app (docs/visual-redesign.md).
 *
 *   VITE_API_BASE_URL=http://localhost:8010 npx vite --port 5174   # dev build, real API
 *   node scripts/screenshots.mjs [outDir] [only-prefix]
 *
 * Drives real clicks on rendered markers (the dev build exposes the map as window.__map).
 * Every image is the actual implementation; nothing is composited afterwards. */
import { mkdirSync } from "node:fs";
import { chromium, devices } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:5174";
const OUT = process.argv[2] ?? "../../docs/screenshots/redesign";
const ONLY = process.argv[3] ?? "";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const PHONE = { ...devices["Pixel 7"] };

async function open(ctxOpts, query = "") {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(`${BASE}/${query}`);
  await page.waitForFunction(() => window.__map?.loaded());
  await settle(page);
  return page;
}

async function settle(page, ms = 1200) {
  await page.waitForFunction(() => !window.__map.isMoving() && window.__map.areTilesLoaded(), null, { timeout: 30000 });
  await page.waitForTimeout(ms);
}

async function jump(page, lon, lat, zoom) {
  await page.evaluate(([lon, lat, zoom]) => window.__map.jumpTo({ center: [lon, lat], zoom }), [lon, lat, zoom]);
  await page.waitForTimeout(1500); // moveend → search
  await settle(page);
}

/** Rendered job features of the given layers, with screen positions. */
async function rendered(page, layers) {
  return page.evaluate((layers) => {
    const m = window.__map;
    const r = m.getContainer().getBoundingClientRect();
    return m.queryRenderedFeatures({ layers }).map((f) => {
      const p = m.project(f.geometry.coordinates);
      return { layer: f.layer.id, props: f.properties, x: p.x + r.left, y: p.y + r.top };
    });
  }, layers);
}

/** Click the badge body (the badge sits above its tip, which is the coordinate). */
async function clickBadge(page, f) {
  await page.mouse.click(f.x, f.y - 23);
}

const shots = [];
const shot = (name, fn) => shots.push([name, fn]);
const save = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });

{
  const q = "";
  const tag = "D";

  shot(`${tag}-01-home`, async () => {
    const page = await open(DESKTOP, q);
    await save(page, `${tag}-01-home`);
    return page;
  });

  shot(`${tag}-02-selected`, async () => {
    const page = await open(DESKTOP, q);
    await jump(page, -79.3905, 43.6505, 14.6);
    const singles = await rendered(page, ["job-points"]);
    const pick = singles.find((f) => f.props.workplace_type !== "unknown" && f.x > 400 && f.x < 1100 && f.y > 200 && f.y < 760) ??
      singles.find((f) => f.x > 400 && f.x < 1100 && f.y > 200 && f.y < 760) ?? singles[0];
    await clickBadge(page, pick);
    await page.waitForSelector("#job-detail-title");
    await settle(page, 800);
    await save(page, `${tag}-02-selected`);
    return page;
  });

  shot(`${tag}-03-district`, async () => {
    const page = await open(DESKTOP, q);
    await jump(page, -79.385, 43.65, 14.2);
    await save(page, `${tag}-03-district`);
    return page;
  });

  shot(`${tag}-04-street-stack`, async () => {
    const page = await open(DESKTOP, q);
    await jump(page, -79.3895, 43.6462, 16.8);
    await save(page, `${tag}-04-street`);
    const stacks = await rendered(page, ["job-stacks"]);
    const stack = stacks.sort((a, b) => b.props.count - a.props.count)[0];
    if (stack) {
      await clickBadge(page, stack);
      await page.waitForSelector("#same-site-title");
      await page.waitForTimeout(1500);
      await save(page, `${tag}-05-same-site`);
    }
    return page;
  });
}

shot("D-06-list", async () => {
  const page = await open(DESKTOP);
  await page.getByRole("button", { name: /View list of/ }).click();
  await page.waitForTimeout(800);
  await save(page, "D-06-list");
  // Open a job without a pin from the list: detail as a bottom card, no invented location.
  const first = page.locator('section[aria-labelledby="group-location_unverified"] button[data-job-id]').first();
  await first.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await save(page, "D-06b-list-unconfirmed");
  await first.click();
  await page.waitForSelector("#job-detail-title");
  await page.waitForTimeout(800);
  await save(page, "D-07-no-pin-detail");
  return page;
});

shot("D-08-filters", async () => {
  const page = await open(DESKTOP);
  await page.getByLabel("Job title or keyword").fill("engineer");
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByText("Past 7 days").click();
  await page.waitForTimeout(2500);
  await settle(page);
  await save(page, "D-08-filters");
  return page;
});

shot("D-09-empty", async () => {
  const page = await open(DESKTOP);
  await page.getByLabel("Job title or keyword").fill("zzqxv underwater welder");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /View list of/ }).click();
  await page.waitForTimeout(800);
  await save(page, "D-09-empty");
  return page;
});

shot("D-10-city", async () => {
  const page = await open(DESKTOP);
  await jump(page, -79.45, 43.72, 10.3);
  await save(page, "D-10-city");
  return page;
});

shot("M-01-home", async () => {
  const page = await open(PHONE);
  await save(page, "M-01-home");
  await jump(page, -79.3905, 43.6505, 14.6);
  const singles = await rendered(page, ["job-points"]);
  const vw = page.viewportSize();
  const pick = singles.find((f) => f.x > 60 && f.x < vw.width - 60 && f.y > 160 && f.y < vw.height - 160) ?? singles[0];
  await clickBadge(page, pick);
  await page.waitForSelector("#job-detail-title");
  await page.waitForTimeout(800);
  await save(page, "M-02-detail");
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: /View list of/ }).click();
  await page.waitForTimeout(800);
  await save(page, "M-03-list");
  return page;
});

/** Asset sheet: the real marker images (same code as the map) on land, park and water
 * swatches, plus the shared icon set. */
shot("Z-assets", async () => {
  const page = await open({ viewport: { width: 1840, height: 640 }, deviceScaleFactor: 1 });
  await page.evaluate(async () => {
    const mi = await import("/src/features/map/markerImages.ts");
    const { GLYPHS } = await import("/src/theme/glyphs.ts");
    const bgs = [["Paper", "#fdfbf5"], ["Tone", "#e3e0dc"], ["Park", "#bdf0c8"], ["Water", "#7fd3ff"], ["Road", "#ffffff"]];
    const root = document.createElement("div");
    root.style.cssText = "position:fixed;inset:0;z-index:99;background:#fffaf0;padding:18px 26px;overflow:hidden;font:600 12px 'M PLUS Rounded 1c',system-ui;color:#2b3566";
    const toCanvas = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      c.getContext("2d").putImageData(img, 0, 0); c.style.width = img.width / 2 + "px"; c.style.height = img.height / 2 + "px"; return c; };
    const title = (t) => { const h = document.createElement("h2"); h.textContent = t; h.style.cssText = "margin:8px 0 8px;font:800 17px 'M PLUS Rounded 1c'"; root.append(h); };
    const ids = [["On-site", "marker-on_site"], ["Hybrid", "marker-hybrid"], ["Remote", "marker-remote"], ["Not stated", "marker-unknown"], ["Inferred office (on-site)", "marker-on_site-inferred"], ["Same address", "stack"]];
    title("Job markers — default / hover / selected, on every map surface (tip = exact coordinate)");
    const row = document.createElement("div"); row.style.cssText = "display:flex;gap:10px";
    for (const [bgName, bg] of bgs) {
      const cell = document.createElement("div");
      cell.style.cssText = `background:${bg};border-radius:0;padding:8px 10px;display:grid;gap:2px;border:2px solid #2b3566`;
      const lab = document.createElement("div"); lab.textContent = bgName; lab.style.cssText = "font-weight:800"; cell.append(lab);
      for (const state of ["default", "hover", "selected"]) {
        const r = document.createElement("div"); r.style.cssText = "display:flex;align-items:flex-end;gap:0;min-height:44px";
        for (const [, id] of ids) r.append(toCanvas(mi.imageFor(state === "default" ? id : `${id}-${state}`)));
        cell.append(r);
      }
      row.append(cell);
    }
    root.append(row);
    const legend = document.createElement("div"); legend.style.cssText = "margin:4px 0 6px;color:#5f6690";
    legend.textContent = "Columns: " + ids.map(([n]) => n).join(" · ") + ". Counts on stacks/clusters are drawn by the map as text.";
    root.append(legend);
    title("Region clusters · landmark stickers (real OSM POIs) · street tree · textures");
    const r2 = document.createElement("div"); r2.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap";
    for (const t of ["s", "m", "l"]) r2.append(toCanvas(mi.imageFor(`cluster-${t}`)));
    for (const k of ["station", "university", "stadium", "museum", "hospital", "library", "ferry_terminal", "attraction", "park"]) {
      const w = document.createElement("div"); w.style.cssText = "display:grid;justify-items:center;font-size:10px"; w.append(toCanvas(mi.imageFor(`lm-${k}`)), k); r2.append(w);
    }
    r2.append(toCanvas(mi.imageFor("street-tree")));
    for (const [tex, bg] of [["tex-trees", "#bdf0c8"], ["tex-water", "#7fd3ff"], ["tone-light", "#fdfbf5"], ["tone-pink", "#fdfbf5"], ["tone-lines", "#fdfbf5"], ["tone-sun", "#fdfbf5"]]) {
      const c = toCanvas(mi.imageFor(tex)); const box = document.createElement("div");
      box.style.cssText = `width:110px;height:70px;border:2px solid #2b3566;border-radius:10px;background:${bg} url(${c.toDataURL()});background-size:${c.width / 2}px ${c.height / 2}px`;
      r2.append(box);
    }
    root.append(r2);
    title("Shared glyph set (24px grid, 2px stroke, even-odd solids)");
    const g = document.createElement("div"); g.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
    for (const [name, gl] of Object.entries(GLYPHS)) {
      const c = document.createElement("div"); c.style.cssText = "display:grid;justify-items:center;gap:2px;width:64px;padding:5px 0;border:2px solid #f0dfbf;border-radius:10px;font-size:10px;color:#5f6690";
      c.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26" style="color:#2b3566">${gl.fill ? `<path d="${gl.fill}" fill="currentColor" fill-rule="evenodd"/>` : ""}${gl.stroke ? `<path d="${gl.stroke}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : ""}</svg>${name}`;
      g.append(c);
    }
    root.append(g);
    document.body.append(root);
  });
  await page.waitForTimeout(500);
  await save(page, "Z-assets");
  return page;
});

/** Share of the app viewport where the map is not covered by an opaque panel. */
shot("Z-coverage", async () => {
  for (const [label, opts] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    const page = await open(opts);
    const pct = await page.evaluate(() => {
      const W = innerWidth, H = innerHeight;
      const sel = ['[role="search"]', '[aria-expanded][aria-controls]', '[role="status"][aria-live]', 'button[aria-label^="View list"]',
        'button[aria-label="Show my location"]', 'button[aria-label="Zoom in"]', 'button[aria-label="Zoom out"]', ".maplibregl-ctrl-attrib"];
      const grid = new Uint8Array(W * H);
      for (const s of sel) for (const el of document.querySelectorAll(s)) {
        const r = el.getBoundingClientRect();
        for (let y = Math.max(0, r.top | 0); y < Math.min(H, r.bottom); y++) grid.fill(1, y * W + Math.max(0, r.left | 0), y * W + Math.min(W, Math.ceil(r.right)));
      }
      return 100 - (grid.reduce((a, b) => a + b, 0) / (W * H)) * 100;
    });
    console.log(`map unobstructed (${label}): ${pct.toFixed(1)}%`);
    await page.context().close();
  }
  return { context: () => ({ close: async () => {} }) };
});

for (const [name, fn] of shots) {
  if (ONLY && !name.startsWith(ONLY)) continue;
  try {
    const page = await fn();
    await page.context().close();
    console.log("ok", name);
  } catch (e) {
    console.log("FAIL", name, e.message.split("\n")[0]);
  }
}
await browser.close();
