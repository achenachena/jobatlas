/** Canvas-drawn artwork for the "Twilight City" map, registered as MapLibre images before any
 * tile is built. Nothing here is a bitmap from elsewhere.
 *
 * Job markers are game-style "quest beacons": a glowing badge floating above the exact point,
 * joined to it by a thin beam of light, with a small light pool on the ground. The ground
 * point (bottom of the image) is the coordinate. Each workplace type differs by STRUCTURE
 * and GLYPH, never by colour alone:
 *   on-site  — solid amber badge, office glyph
 *   hybrid   — split badge (mint / dark), home + office glyph
 *   remote   — hollow badge (dark fill, sakura ring), signal glyph
 *   unknown  — dark badge with a dashed pale ring and a dot ("arrangement not stated")
 * A "≈" chip marks an inferred office (the company's only office in the city).
 * Same address: a badge with two ghost cards behind and the count. Region cluster: a ring of
 * light with the count (no beam: it is an area, not a point). */
import type { Map as MlMap } from "maplibre-gl";

import { GLYPHS, type Glyph, type GlyphName } from "../../theme/glyphs";
import { C, INK, KIND_COLORS, type MarkerKind, PAPER } from "../../theme/palette";

const PIXEL_RATIO = 2;
const BODY = 30; // badge edge at scale 1
const BEAM = 22; // beam from the ground point up to the badge
const POOL = 6; // light pool below the ground point
const PAD = 14; // glow around the badge

export const MARKER_KINDS: MarkerKind[] = ["on_site", "hybrid", "remote", "unknown"];
export type MarkerState = "default" | "hover" | "selected";
const STATE_SCALE: Record<MarkerState, number> = { default: 1, hover: 1.1, selected: 1.22 };

/** Pixels from the coordinate up to the badge centre, for a badge drawn at `scale`. */
export const centerOffset = (scale = 1) => BEAM + (BODY * scale) / 2;
export const BADGE_CENTER_OFFSET = centerOffset(1);
/** Images extend POOL px under the coordinate; with icon-anchor "bottom" the layers shift
 * them down by this much so the ground point sits exactly on the coordinate. */
export const MARKER_ICON_OFFSET: Record<MarkerState, [number, number]> = {
  default: [0, POOL],
  hover: [0, POOL],
  selected: [0, POOL],
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

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Badge outline: a soft rounded square with one cut corner (top-right). */
function badgePath(cx: number, cy: number, b: number): Path2D {
  const h = b / 2;
  const r = b * 0.26;
  const cut = b * 0.22;
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

function radialGlow(ctx: Ctx, x: number, y: number, r: number, color: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** The beam from the ground point up to the badge, and the light pool on the ground. */
function beam(ctx: Ctx, cx: number, groundY: number, topY: number, color: string, strong: boolean) {
  ctx.save();
  ctx.translate(cx, groundY);
  ctx.scale(1, 0.35);
  radialGlow(ctx, 0, 0, strong ? 16 : 11, color, strong ? 0.75 : 0.55);
  ctx.restore();
  const g = ctx.createLinearGradient(0, groundY, 0, topY);
  g.addColorStop(0, rgba(color, strong ? 1 : 0.9));
  g.addColorStop(1, rgba(color, 0.15));
  ctx.fillStyle = g;
  const w = strong ? 2.4 : 1.6;
  ctx.fillRect(cx - w / 2, topY, w, groundY - topY);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, groundY, strong ? 2.4 : 1.8, 0, Math.PI * 2);
  ctx.fill();
}

/** Four-point sparkle. */
function sparkle(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x + r * 0.12, y - r * 0.12, x + r, y);
  ctx.quadraticCurveTo(x + r * 0.12, y + r * 0.12, x, y + r);
  ctx.quadraticCurveTo(x - r * 0.12, y + r * 0.12, x - r, y);
  ctx.quadraticCurveTo(x - r * 0.12, y - r * 0.12, x, y - r);
  ctx.fill();
}

/** Selection: two thin rings of light, corner ticks and sparkles. */
function selectionFrame(ctx: Ctx, cx: number, cy: number, half: number, color: string) {
  ctx.save();
  ctx.strokeStyle = rgba(color, 0.9);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, half + 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = rgba(PAPER, 0.5);
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.arc(cx, cy, half + 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  sparkle(ctx, cx + half + 9, cy - half - 4, 4.5, "#ffffff");
  sparkle(ctx, cx - half - 8, cy + half - 2, 3, rgba(color, 1));
}

function inferredChip(ctx: Ctx, x: number, y: number) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 6.8, 0, Math.PI * 2);
  ctx.fillStyle = C.amber;
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.lineWidth = 1.5;
  for (const dy of [-1.7, 1.7]) {
    ctx.beginPath();
    ctx.moveTo(x - 3.4, y + dy + 0.6);
    ctx.quadraticCurveTo(x - 1.7, y + dy - 1.5, x, y + dy);
    ctx.quadraticCurveTo(x + 1.7, y + dy + 1.5, x + 3.4, y + dy - 0.6);
    ctx.stroke();
  }
  ctx.restore();
}

/** Canvas for a beacon: badge of edge `b` above a beam; returns the badge centre too. */
function beaconCanvas(b: number) {
  const w = b + PAD * 2;
  const h = PAD + b + BEAM + POOL;
  const [c, ctx] = canvas(w, h);
  return { c, ctx, w, h, cx: w / 2, cy: PAD + b / 2, groundY: PAD + b + BEAM };
}

export function drawMarker(kind: MarkerKind, state: MarkerState, inferred = false): ImageData {
  const s = STATE_SCALE[state] * (kind === "unknown" ? 0.9 : 1);
  const b = BODY * s;
  const { c, ctx, w, h, cx, cy, groundY } = beaconCanvas(b);
  const col = KIND_COLORS[kind];
  const glowColor = kind === "unknown" ? C.lavender : col.base;
  const strong = state !== "default";

  beam(ctx, cx, groundY, cy + b / 2, glowColor, strong);
  radialGlow(ctx, cx, cy, b * (strong ? 1.0 : 0.85), glowColor, strong ? 0.55 : 0.35);
  if (state === "selected") selectionFrame(ctx, cx, cy, b / 2, glowColor);

  const shape = badgePath(cx, cy, b);
  ctx.save();
  ctx.clip(shape);
  if (kind === "hybrid") {
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = col.base;
    ctx.fillRect(0, 0, cx, h);
  } else {
    ctx.fillStyle = kind === "on_site" ? col.base : INK;
    ctx.fillRect(0, 0, w, h);
  }
  // top sheen
  const sheen = ctx.createLinearGradient(0, cy - b / 2, 0, cy);
  sheen.addColorStop(0, "rgba(255,255,255,0.35)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, cy - b / 2, w, b / 2);
  ctx.restore();

  ctx.lineWidth = 1.6;
  ctx.strokeStyle = kind === "on_site" ? "#fff6dc" : glowColor;
  ctx.stroke(shape);
  if (kind === "remote" || kind === "unknown") {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(0.72, 0.72);
    ctx.translate(-cx, -cy);
    ctx.lineWidth = (kind === "remote" ? 2.6 : 1.4) / 0.72;
    if (kind === "unknown") ctx.setLineDash([3 / 0.72, 2.6 / 0.72]);
    ctx.strokeStyle = kind === "remote" ? col.base : rgba(PAPER, 0.75);
    ctx.stroke(badgePath(cx, cy, b));
    ctx.restore();
  }

  const gs = b * (kind === "remote" ? 0.46 : kind === "unknown" ? 0.42 : 0.58);
  if (kind === "hybrid") {
    for (const [x0, color] of [[0, INK], [cx, col.base]] as const) {
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

/** Several jobs at one address: a badge with two ghost cards behind (count = map text). */
export function drawStack(state: MarkerState): ImageData {
  const s = STATE_SCALE[state];
  const b = BODY * s;
  const { c, ctx, cx, cy, groundY } = beaconCanvas(b);
  const strong = state !== "default";
  beam(ctx, cx, groundY, cy + b / 2, C.lavender, strong);
  radialGlow(ctx, cx, cy, b * 0.95, C.lavender, strong ? 0.55 : 0.35);
  if (state === "selected") selectionFrame(ctx, cx, cy, b / 2 + 2, C.lavender);
  for (const [off, a] of [[6, 0.35], [3, 0.6]] as const) {
    const ghost = badgePath(cx + off, cy - off, b);
    ctx.fillStyle = rgba(C.dusk, 0.9);
    ctx.fill(ghost);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = rgba(C.lavender, a);
    ctx.stroke(ghost);
  }
  const shape = badgePath(cx, cy, b);
  const g = ctx.createLinearGradient(0, cy - b / 2, 0, cy + b / 2);
  g.addColorStop(0, "#5a4fc0");
  g.addColorStop(1, "#2c2878");
  ctx.fillStyle = g;
  ctx.fill(shape);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "#d8d2ff";
  ctx.stroke(shape);
  return imageOf(c);
}

export const CLUSTER_TIERS = { s: 15, m: 19, l: 24 } as const;
export type ClusterTier = keyof typeof CLUSTER_TIERS;

/** Region cluster: a disc of light with two rings and tick marks (count = map text). */
export function drawCluster(tier: ClusterTier): ImageData {
  const r = CLUSTER_TIERS[tier];
  const size = (r + 18) * 2;
  const [c, ctx] = canvas(size, size);
  const cx = size / 2;
  radialGlow(ctx, cx, cx, r + 18, C.amber, 0.45);
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(cx, cx - r * 0.4, r * 0.1, cx, cx, r);
  g.addColorStop(0, "#fff3d0");
  g.addColorStop(1, C.amber);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "#fff8e6";
  ctx.stroke();
  ctx.strokeStyle = rgba(C.amber, 0.85);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cx, r + 6, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r + 9), cx + Math.sin(a) * (r + 9));
    ctx.lineTo(cx + Math.cos(a) * (r + 14), cx + Math.sin(a) * (r + 14));
    ctx.stroke();
  }
  return imageOf(c);
}

/** Landmarks: small dark discs with a thin coloured ring and a pale glyph. */
export const LANDMARKS: Record<string, { glyph: GlyphName; color: string }> = {
  station: { glyph: "train", color: C.cyan },
  university: { glyph: "cap", color: C.amber },
  college: { glyph: "cap", color: C.amber },
  stadium: { glyph: "stadium", color: C.mint },
  museum: { glyph: "museum", color: C.sakura },
  gallery: { glyph: "museum", color: C.sakura },
  theatre: { glyph: "museum", color: C.sakura },
  hospital: { glyph: "cross", color: C.sakura },
  library: { glyph: "book", color: C.lavender },
  ferry_terminal: { glyph: "anchor", color: C.cyan },
  marina: { glyph: "anchor", color: C.cyan },
  attraction: { glyph: "star", color: C.amber },
  aquarium: { glyph: "star", color: C.amber },
  zoo: { glyph: "star", color: C.amber },
  theme_park: { glyph: "star", color: C.amber },
  park: { glyph: "tree", color: C.mint },
  garden: { glyph: "tree", color: C.mint },
};

function drawLandmark(kind: string): ImageData | null {
  const lm = LANDMARKS[kind];
  if (!lm) return null;
  const [c, ctx] = canvas(30, 30);
  radialGlow(ctx, 15, 15, 15, lm.color, 0.35);
  ctx.beginPath();
  ctx.arc(15, 15, 9.5, 0, Math.PI * 2);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = lm.color;
  ctx.stroke();
  drawGlyph(ctx, GLYPHS[lm.glyph], 15, 15, 11.5, lm.color, 2.4);
  return imageOf(c);
}

/** Facade textures for the extruded buildings (fill-extrusion-pattern): a body colour with a
 * grid of windows, a share of them lit warm. Three height bands get different bodies and
 * window densities. Deterministic, so the city looks the same on every load. */
export const FACADES: Record<string, { body: string; lit: number; size: number }> = {
  "facade-low": { body: "#3a43a6", lit: 0.22, size: 64 },
  "facade-mid": { body: "#4f53c4", lit: 0.3, size: 64 },
  "facade-tall": { body: "#6d68dc", lit: 0.38, size: 64 },
};

function drawFacade(id: string): ImageData | null {
  const f = FACADES[id];
  if (!f) return null;
  const n = f.size;
  const [c, ctx] = canvas(n, n);
  ctx.fillStyle = f.body;
  ctx.fillRect(0, 0, n, n);
  let seed = id.length * 7919;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let y = 2; y < n; y += 6) {
    for (let x = 2; x < n; x += 5) {
      const r = rnd();
      ctx.fillStyle = r < f.lit ? (r < f.lit * 0.25 ? "#ffe6a8" : "#ffc27d") : r < f.lit + 0.25 ? "rgba(170,165,255,0.45)" : "rgba(15,18,60,0.35)";
      ctx.fillRect(x, y, 3, 3.4);
    }
  }
  return imageOf(c);
}

/** Water: city light reflected as short horizontal shimmer streaks on deep navy. */
function drawWater(): ImageData {
  const n = 96;
  const [c, ctx] = canvas(n, n);
  ctx.fillStyle = C.water;
  ctx.fillRect(0, 0, n, n);
  let seed = 42;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 26; i++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const w = 3 + rnd() * 9;
    const r = rnd();
    ctx.fillStyle = r < 0.2 ? "rgba(255,200,150,0.55)" : r < 0.55 ? "rgba(140,150,255,0.45)" : "rgba(90,140,230,0.4)";
    ctx.fillRect(x, y, w, 1);
  }
  return imageOf(c);
}

export const IMAGE_IDS: string[] = [
  "water-shimmer",
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
  if (id === "water-shimmer") return drawWater();
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
