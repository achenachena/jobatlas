/** Canvas-painted artwork for the "Painted Summer Town" map, registered as MapLibre images
 * before any tile is built. Nothing here is a bitmap from elsewhere.
 *
 * Painted, not drawn: soft dabs of colour instead of flat fills, cool blue-violet shadows,
 * warm light, no black outlines and no glow.
 *  - textures: painted ground wash, lush tree crowns for parks, sparkling turquoise water,
 *    and building facades (cream / white walls with windows, sky-blue glass for towers);
 *  - job markers: a little painted sign on a pin — the pin's point is the coordinate; each
 *    workplace type differs by STRUCTURE and GLYPH, never by colour alone (solid on-site,
 *    split hybrid, hollow remote, dashed "arrangement not stated"); a "≈" chip marks an
 *    inferred office; a fan of cards marks several jobs at one address;
 *  - region clusters: a soft cream disc with a painted ring (count = map text);
 *  - landmarks: small cream discs with a coloured glyph. */
import type { Map as MlMap } from "maplibre-gl";

import { GLYPHS, type Glyph, type GlyphName } from "../../theme/glyphs";
import { C, INK, KIND_COLORS, type MarkerKind, PAPER } from "../../theme/palette";

const PIXEL_RATIO = 2;
const BODY = 30; // sign edge at scale 1
const POLE = 14; // pole from the ground point up to the sign
const GROUND = 5; // soft shadow below the ground point
const PAD = 8;

export const MARKER_KINDS: MarkerKind[] = ["on_site", "hybrid", "remote", "unknown"];
export type MarkerState = "default" | "hover" | "selected";
const STATE_SCALE: Record<MarkerState, number> = { default: 1, hover: 1.1, selected: 1.22 };
const PAD_STATE: Record<MarkerState, number> = { default: PAD, hover: PAD, selected: 16 };

/** Pixels from the coordinate up to the sign centre, for a sign drawn at `scale`. */
export const centerOffset = (scale = 1) => POLE + (BODY * scale) / 2;
export const BADGE_CENTER_OFFSET = centerOffset(1);
/** Images extend GROUND px under the coordinate; layers shift them down by this much. */
export const MARKER_ICON_OFFSET: Record<MarkerState, [number, number]> = {
  default: [0, GROUND],
  hover: [0, GROUND],
  selected: [0, GROUND],
};

type Ctx = CanvasRenderingContext2D;

function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * PIXEL_RATIO);
  c.height = Math.ceil(h * PIXEL_RATIO);
  const ctx = c.getContext("2d")!;
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  return [c, ctx];
}

const imageOf = (c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height);

/** Deterministic pseudo-random, so the painting is identical on every load. */
export function rand(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Soft brush dabs: rotated ellipses of low opacity, wrapped so the tile repeats seamlessly. */
function dabs(ctx: Ctx, n: number, size: number, colors: string[], r: () => number, len: [number, number], alpha: [number, number], angle?: number) {
  for (let i = 0; i < n; i++) {
    const x = r() * size;
    const y = r() * size;
    const l = len[0] + r() * (len[1] - len[0]);
    const a = angle ?? r() * Math.PI;
    const thin = 0.35 + r() * 0.3;
    ctx.fillStyle = rgba(colors[Math.floor(r() * colors.length)]!, alpha[0] + r() * (alpha[1] - alpha[0]));
    for (const [dx, dy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      ctx.beginPath();
      ctx.ellipse(x + dx!, y + dy!, l, l * thin, a, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawGlyph(ctx: Ctx, glyph: Glyph, cx: number, cy: number, size: number, color: string, weight = 2.4) {
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = weight;
  if (glyph.fill) ctx.fill(new Path2D(glyph.fill), "evenodd");
  if (glyph.stroke) ctx.stroke(new Path2D(glyph.stroke));
  ctx.restore();
}

// ------------------------------------------------------------------ textures

const TEXTURES: Record<string, () => ImageData> = {
  "paint-land": () => {
    const n = 128;
    const [c, ctx] = canvas(n, n);
    ctx.fillStyle = C.land;
    ctx.fillRect(0, 0, n, n);
    dabs(ctx, 60, n, ["#fff8e6", "#eadcbc", "#f6e7c8", "#e9e2d0"], rand(11), [6, 16], [0.25, 0.5]);
    return imageOf(c);
  },
  "paint-grass": () => {
    const n = 112;
    const [c, ctx] = canvas(n, n);
    ctx.fillStyle = C.grass;
    ctx.fillRect(0, 0, n, n);
    const r = rand(23);
    dabs(ctx, 50, n, ["#b8e38a", "#8ccb6c", "#c8eb98", "#7fbf62"], r, [5, 12], [0.35, 0.6]);
    // lush tree crowns: cool shadow, body, sunlit top-left
    for (let i = 0; i < 9; i++) {
      const x = r() * n;
      const y = r() * n;
      const rad = 7 + r() * 6;
      for (const [dx, dy] of [[0, 0], [n, 0], [-n, 0], [0, n], [0, -n]]) {
        const cx = x + dx!;
        const cy = y + dy!;
        ctx.fillStyle = "rgba(60,110,120,0.35)";
        ctx.beginPath();
        ctx.ellipse(cx + rad * 0.35, cy + rad * 0.55, rad, rad * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = C.forest;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#6fbf5f";
        ctx.beginPath();
        ctx.arc(cx - rad * 0.2, cy - rad * 0.25, rad * 0.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(220,245,160,0.8)";
        ctx.beginPath();
        ctx.arc(cx - rad * 0.38, cy - rad * 0.42, rad * 0.32, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return imageOf(c);
  },
  "paint-water": () => {
    const n = 128;
    const [c, ctx] = canvas(n, n);
    ctx.fillStyle = C.water;
    ctx.fillRect(0, 0, n, n);
    const r = rand(37);
    dabs(ctx, 40, n, ["#6fd3ef", "#3aaedc", "#8ee0f5"], r, [10, 22], [0.3, 0.5], 0);
    // sunlight glints
    for (let i = 0; i < 14; i++) {
      const x = r() * n;
      const y = r() * n;
      const w = 3 + r() * 8;
      ctx.fillStyle = `rgba(255,255,255,${0.55 + r() * 0.4})`;
      ctx.beginPath();
      ctx.ellipse(x, y, w, 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    return imageOf(c);
  },
};

/** Building facades (fill-extrusion-pattern): painted wall wash with rows of windows. */
const FACADES: Record<string, { wall: string[]; window: string; glass?: boolean }> = {
  "facade-low": { wall: ["#fff8ec", "#ffeede", "#fde3d6", "#fff2e2"], window: "#7fa3dd" },
  "facade-mid": { wall: ["#ffffff", "#f3f6ff", "#fff8f0", "#eef3ff"], window: "#6d98e0" },
  "facade-tall": { wall: ["#a9dcff", "#86c9fb", "#c9ebff", "#97d3ff"], window: "#ffffff", glass: true },
};

function drawFacade(id: string): ImageData | null {
  const f = FACADES[id];
  if (!f) return null;
  const n = 64;
  const [c, ctx] = canvas(n, n);
  ctx.fillStyle = f.wall[0]!;
  ctx.fillRect(0, 0, n, n);
  const r = rand(id.length * 977);
  dabs(ctx, 22, n, f.wall, r, [6, 14], [0.4, 0.7], f.glass ? -0.9 : Math.PI / 2);
  if (f.glass) {
    // sky reflected on glass: soft diagonal light bands
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    for (const x0 of [8, 40]) {
      ctx.beginPath();
      ctx.moveTo(x0, n);
      ctx.lineTo(x0 + 10, n);
      ctx.lineTo(x0 + 26, 0);
      ctx.lineTo(x0 + 16, 0);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(120,160,220,0.35)";
    for (let y = 4; y < n; y += 8) ctx.fillRect(0, y, n, 0.8);
  } else {
    for (let y = 5; y < n; y += 10) {
      for (let x = 4; x < n; x += 8) {
        ctx.fillStyle = rgba(f.window, 0.55 + r() * 0.3);
        ctx.fillRect(x, y, 4, 5);
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillRect(x, y, 1.2, 5);
      }
    }
  }
  return imageOf(c);
}

// ------------------------------------------------------------------ markers

/** Soft rounded sign with one cut corner (top-right). */
function signPath(cx: number, cy: number, b: number): Path2D {
  const h = b / 2;
  const r = b * 0.28;
  const cut = b * 0.2;
  const p = new Path2D();
  p.moveTo(cx - h + r, cy - h);
  p.lineTo(cx + h - cut, cy - h);
  p.lineTo(cx + h, cy - h + cut);
  p.lineTo(cx + h, cy + h - r);
  p.quadraticCurveTo(cx + h, cy + h, cx + h - r, cy + h);
  p.lineTo(cx - h + r, cy + h);
  p.quadraticCurveTo(cx - h, cy + h, cx - h, cy + h - r);
  p.lineTo(cx - h, cy - h + r);
  p.quadraticCurveTo(cx - h, cy - h, cx - h + r, cy - h);
  p.closePath();
  return p;
}

function groundShadow(ctx: Ctx, cx: number, y: number, w: number) {
  const g = ctx.createRadialGradient(cx, y, 0, cx, y, w);
  g.addColorStop(0, "rgba(70,80,140,0.35)");
  g.addColorStop(1, "rgba(70,80,140,0)");
  ctx.save();
  ctx.translate(cx, y);
  ctx.scale(1, 0.35);
  ctx.translate(-cx, -y);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, y, w, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function selectionHalo(ctx: Ctx, cx: number, cy: number, half: number) {
  const g = ctx.createRadialGradient(cx, cy, half * 0.8, cx, cy, half + 15);
  g.addColorStop(0, "rgba(255,214,110,0.75)");
  g.addColorStop(1, "rgba(255,214,110,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, half + 15, 0, Math.PI * 2);
  ctx.fill();
}

function inferredChip(ctx: Ctx, x: number, y: number) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 6.6, 0, Math.PI * 2);
  ctx.fillStyle = C.sun;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.strokeStyle = INK;
  for (const dy of [-1.7, 1.7]) {
    ctx.beginPath();
    ctx.moveTo(x - 3.3, y + dy + 0.6);
    ctx.quadraticCurveTo(x - 1.6, y + dy - 1.5, x, y + dy);
    ctx.quadraticCurveTo(x + 1.6, y + dy + 1.5, x + 3.3, y + dy - 0.6);
    ctx.stroke();
  }
  ctx.restore();
}

/** Painted fill: base colour, a warm light top-left, a cool shade lower-right. */
function paintFill(ctx: Ctx, shape: Path2D, cx: number, cy: number, b: number, base: string, shade: string) {
  ctx.save();
  ctx.clip(shape);
  ctx.fillStyle = base;
  ctx.fillRect(cx - b, cy - b, b * 2, b * 2);
  const g = ctx.createLinearGradient(cx - b / 2, cy - b / 2, cx + b / 2, cy + b / 2);
  g.addColorStop(0, "rgba(255,255,255,0.35)");
  g.addColorStop(0.5, "rgba(255,255,255,0)");
  g.addColorStop(1, rgba(shade, 0.65));
  ctx.fillStyle = g;
  ctx.fillRect(cx - b, cy - b, b * 2, b * 2);
  ctx.restore();
}

function signCanvas(b: number, state: MarkerState) {
  const pad = PAD_STATE[state];
  const w = b + pad * 2;
  const h = pad + b + POLE + GROUND;
  const [c, ctx] = canvas(w, h);
  return { c, ctx, w, h, cx: w / 2, cy: pad + b / 2, groundY: pad + b + POLE };
}

function pole(ctx: Ctx, cx: number, top: number, groundY: number) {
  groundShadow(ctx, cx, groundY, 9);
  ctx.strokeStyle = "#5b6380";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx, groundY);
  ctx.stroke();
  ctx.fillStyle = "#5b6380";
  ctx.beginPath();
  ctx.arc(cx, groundY, 2, 0, Math.PI * 2);
  ctx.fill();
}

export function drawMarker(kind: MarkerKind, state: MarkerState, inferred = false): ImageData {
  const s = STATE_SCALE[state] * (kind === "unknown" ? 0.9 : 1);
  const b = BODY * s;
  const { c, ctx, h, cx, cy, groundY } = signCanvas(b, state);
  const col = KIND_COLORS[kind];
  if (state === "selected") selectionHalo(ctx, cx, cy, b / 2);
  pole(ctx, cx, cy + b / 2 - 2, groundY);
  const shape = signPath(cx, cy, b);
  ctx.save();
  ctx.translate(1.5, 2.5);
  ctx.fillStyle = "rgba(60,70,130,0.28)";
  ctx.fill(shape);
  ctx.restore();
  if (kind === "hybrid") {
    paintFill(ctx, shape, cx, cy, b, PAPER, "#d9d2be");
    ctx.save();
    ctx.clip(shape);
    ctx.beginPath();
    ctx.rect(0, 0, cx, h);
    ctx.clip();
    paintFill(ctx, shape, cx, cy, b, col.base, col.shade);
    ctx.restore();
  } else if (kind === "on_site") {
    paintFill(ctx, shape, cx, cy, b, col.base, col.shade);
  } else {
    paintFill(ctx, shape, cx, cy, b, PAPER, "#d9d2be");
  }
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = kind === "on_site" || kind === "hybrid" ? "#ffffff" : col.shade;
  ctx.stroke(shape);
  if (kind === "remote" || kind === "unknown") {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(0.72, 0.72);
    ctx.translate(-cx, -cy);
    ctx.lineWidth = (kind === "remote" ? 2.8 : 1.5) / 0.72;
    if (kind === "unknown") ctx.setLineDash([3 / 0.72, 2.6 / 0.72]);
    ctx.strokeStyle = kind === "remote" ? col.base : "#8a8fa8";
    ctx.stroke(signPath(cx, cy, b));
    ctx.restore();
  }
  const gs = b * (kind === "remote" ? 0.46 : kind === "unknown" ? 0.4 : 0.58);
  if (kind === "hybrid") {
    for (const [x0, color] of [[0, "#ffffff"], [cx, col.shade]] as const) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, cx, h);
      ctx.clip();
      drawGlyph(ctx, GLYPHS.hybrid, cx, cy, gs, color);
      ctx.restore();
    }
  } else {
    const glyph = kind === "on_site" ? GLYPHS.onSite : kind === "remote" ? GLYPHS.remote : GLYPHS.unknown;
    drawGlyph(ctx, glyph, cx, cy, gs, col.glyph);
  }
  if (inferred) inferredChip(ctx, cx + b / 2 - 1, cy - b / 2 + 1);
  return imageOf(c);
}

/** Several jobs at one address: a fan of painted cards behind a sign (count = map text). */
export function drawStack(state: MarkerState): ImageData {
  const s = STATE_SCALE[state];
  const b = BODY * s;
  const { c, ctx, cx, cy, groundY } = signCanvas(b, state);
  if (state === "selected") selectionHalo(ctx, cx, cy, b / 2 + 2);
  pole(ctx, cx, cy + b / 2 - 2, groundY);
  for (const [off, col] of [[6, C.sakura], [3, C.sun]] as const) {
    const card = signPath(cx + off, cy - off, b * 0.94);
    ctx.fillStyle = col;
    ctx.fill(card);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke(card);
  }
  const shape = signPath(cx, cy, b);
  paintFill(ctx, shape, cx, cy, b, "#4f6fd0", "#2f4aa0");
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke(shape);
  return imageOf(c);
}

export const CLUSTER_TIERS = { s: 15, m: 19, l: 24 } as const;
export type ClusterTier = keyof typeof CLUSTER_TIERS;

/** Region cluster: a soft cream disc with a painted sky-blue ring (count = map text). */
export function drawCluster(tier: ClusterTier): ImageData {
  const r = CLUSTER_TIERS[tier];
  const size = (r + 10) * 2;
  const [c, ctx] = canvas(size, size + 4);
  const cx = size / 2;
  groundShadow(ctx, cx, cx + r * 0.75, r * 1.1);
  const disc = new Path2D();
  disc.arc(cx, cx, r, 0, Math.PI * 2);
  paintFill(ctx, disc, cx, cx, r * 1.4, PAPER, "#d6cdb4");
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = C.sky;
  ctx.stroke(disc);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.arc(cx, cx, r + 3.4, 0, Math.PI * 2);
  ctx.stroke();
  return imageOf(c);
}

/** Landmarks: small cream discs with a coloured glyph and a soft shadow. */
export const LANDMARKS: Record<string, { glyph: GlyphName; color: string }> = {
  station: { glyph: "train", color: C.skyDeep },
  university: { glyph: "cap", color: "#d99a1e" },
  college: { glyph: "cap", color: "#d99a1e" },
  stadium: { glyph: "stadium", color: C.teal },
  museum: { glyph: "museum", color: C.terracotta },
  gallery: { glyph: "museum", color: C.terracotta },
  theatre: { glyph: "museum", color: C.terracotta },
  hospital: { glyph: "cross", color: "#e2557a" },
  library: { glyph: "book", color: "#7b6fd0" },
  ferry_terminal: { glyph: "anchor", color: C.skyDeep },
  marina: { glyph: "anchor", color: C.skyDeep },
  attraction: { glyph: "star", color: "#d99a1e" },
  aquarium: { glyph: "star", color: "#d99a1e" },
  zoo: { glyph: "star", color: "#d99a1e" },
  theme_park: { glyph: "star", color: "#d99a1e" },
  park: { glyph: "tree", color: C.grassDeep },
  garden: { glyph: "tree", color: C.grassDeep },
};

function drawLandmark(kind: string): ImageData | null {
  const lm = LANDMARKS[kind];
  if (!lm) return null;
  const [c, ctx] = canvas(28, 30);
  groundShadow(ctx, 14, 23, 10);
  const disc = new Path2D();
  disc.arc(14, 13, 9.5, 0, Math.PI * 2);
  paintFill(ctx, disc, 14, 13, 13, PAPER, "#d6cdb4");
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = lm.color;
  ctx.stroke(disc);
  drawGlyph(ctx, GLYPHS[lm.glyph], 14, 13, 11.5, lm.color, 2.4);
  return imageOf(c);
}

export const IMAGE_IDS: string[] = [
  ...Object.keys(TEXTURES),
  ...Object.keys(FACADES),
  ...MARKER_KINDS.flatMap((k) =>
    ["", "-inferred"].flatMap((v) => [`marker-${k}${v}`, `marker-${k}${v}-hover`, `marker-${k}${v}-selected`]),
  ),
  "stack",
  "stack-hover",
  "stack-selected",
  "cluster-s",
  "cluster-m",
  "cluster-l",
  ...Object.keys(LANDMARKS).map((k) => `lm-${k}`),
];

/** Image id → artwork. */
export function imageFor(id: string): ImageData | null {
  const m = /^marker-(on_site|hybrid|remote|unknown)(-inferred)?(?:-(hover|selected))?$/.exec(id);
  if (m) {
    return drawMarker(m[1] as MarkerKind, (m[3] as MarkerState | undefined) ?? "default", Boolean(m[2]));
  }
  const st = /^stack(?:-(hover|selected))?$/.exec(id);
  if (st) return drawStack((st[1] as MarkerState | undefined) ?? "default");
  const cl = /^cluster-(s|m|l)$/.exec(id);
  if (cl) return drawCluster(cl[1] as ClusterTier);
  if (id.startsWith("lm-")) return drawLandmark(id.slice(3));
  if (TEXTURES[id]) return TEXTURES[id]!();
  return drawFacade(id);
}

/** Register every image as soon as the style exists (so no tile is ever built without one),
 * and keep answering `styleimagemissing` in case the style is reloaded. */
export function provideImages(map: MlMap): void {
  const add = (id: string) => {
    if (map.hasImage(id)) return;
    const img = imageFor(id);
    if (img) map.addImage(id, img, { pixelRatio: PIXEL_RATIO });
  };
  map.on("styleimagemissing", (e: { id: string }) => add(e.id));
  map.once("style.load", () => IMAGE_IDS.forEach(add));
}
