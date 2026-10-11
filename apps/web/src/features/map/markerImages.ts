/** Hand-drawn (canvas) artwork for the map, registered as MapLibre images before any tile is
 * built. Line-art language: 2–2.5px indigo ink outline, flat two-tone cel fills, a white
 * sticker edge, a small gloss highlight. Nothing here is a bitmap from elsewhere.
 *
 * Job markers — a chibi "explore badge" whose tip is the exact coordinate. Each workplace type
 * differs by STRUCTURE and GLYPH, never by colour alone:
 *   on-site  — solid badge, office glyph
 *   hybrid   — split badge (solid half / pale half), home + office glyph
 *   remote   — hollow badge with a thick inner ring, signal glyph
 *   unknown  — smaller pale badge, dashed ring, grey dot ("arrangement not stated"; the
 *              address itself is confirmed, so no "?")
 * Same-address stack: a fan of coloured cards with the count. Region cluster: count medallion
 * on the brand navigation star (no tip — it is an area, not a point).
 *
 * Map illustration — landmark stickers for real POIs, little street trees for real OSM trees,
 * cartoon tree texture for parks, wave + sparkle texture for water, and a stretchable plate
 * for city names. */
import type { Map as MlMap } from "maplibre-gl";

import { GLYPHS, type Glyph, type GlyphName } from "../../theme/glyphs";
import { C, INK, KIND_COLORS, type MarkerKind } from "../../theme/palette";

const PIXEL_RATIO = 2;
const BODY = 32; // badge body edge at scale 1
const TIP = 8; // pin tip length
const PAD = 13; // room for the selection frame
const GROUND = 5; // contact shadow below the tip

/** Pixels from the coordinate (tip) up to the badge centre at scale 1. */
export const BADGE_CENTER_OFFSET = TIP + BODY / 2;
/** The marker image extends GROUND px below the tip; layers shift it back by this much. */
export const MARKER_ICON_OFFSET: [number, number] = [0, GROUND];

export const MARKER_KINDS: MarkerKind[] = ["on_site", "hybrid", "remote", "unknown"];
export type MarkerState = "default" | "hover" | "selected";
const STATE_SCALE: Record<MarkerState, number> = { default: 1, hover: 1.1, selected: 1.2 };

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

/** Rounded badge body + pin tip, centred on (cx, cy). */
function badgePath(cx: number, cy: number, b: number, tip: number): Path2D {
  const p = new Path2D();
  const h = b / 2;
  const r = b * 0.34;
  const [l, rt, t, bt] = [cx - h, cx + h, cy - h, cy + h];
  const tw = b * 0.2;
  p.moveTo(l + r, t);
  p.lineTo(rt - r, t);
  p.quadraticCurveTo(rt, t, rt, t + r);
  p.lineTo(rt, bt - r);
  p.quadraticCurveTo(rt, bt, rt - r, bt);
  p.lineTo(cx + tw, bt);
  p.quadraticCurveTo(cx + tw * 0.3, bt + tip * 0.6, cx, bt + tip);
  p.quadraticCurveTo(cx - tw * 0.3, bt + tip * 0.6, cx - tw, bt);
  p.lineTo(l + r, bt);
  p.quadraticCurveTo(l, bt, l, bt - r);
  p.lineTo(l, t + r);
  p.quadraticCurveTo(l, t, l + r, t);
  p.closePath();
  return p;
}

function drawGlyph(ctx: Ctx, glyph: Glyph, cx: number, cy: number, size: number, color: string, weight = 2.6) {
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

/** 4-point sparkle. */
function sparkle(ctx: Ctx, x: number, y: number, r: number, color: string, outline?: string) {
  const p = new Path2D();
  p.moveTo(x, y - r);
  p.quadraticCurveTo(x + r * 0.15, y - r * 0.15, x + r, y);
  p.quadraticCurveTo(x + r * 0.15, y + r * 0.15, x, y + r);
  p.quadraticCurveTo(x - r * 0.15, y + r * 0.15, x - r, y);
  p.quadraticCurveTo(x - r * 0.15, y - r * 0.15, x, y - r);
  if (outline) {
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = outline;
    ctx.stroke(p);
  }
  ctx.fillStyle = color;
  ctx.fill(p);
}

function groundShadow(ctx: Ctx, cx: number, y: number, w: number) {
  ctx.save();
  ctx.fillStyle = "rgba(43, 53, 102, 0.28)";
  ctx.beginPath();
  ctx.ellipse(cx, y, w, w * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Sun-yellow "locked on" corner brackets (ink-outlined) + two sparkles. */
function selectionFrame(ctx: Ctx, cx: number, cy: number, half: number) {
  const g = half + 5.5;
  const len = 7.5;
  for (const [color, width] of [[INK, 5.5], [C.sun, 3]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const x = cx + sx * g;
      const y = cy + sy * g;
      ctx.beginPath();
      ctx.moveTo(x, y - sy * len);
      ctx.lineTo(x, y);
      ctx.lineTo(x - sx * len, y);
      ctx.stroke();
    }
  }
  sparkle(ctx, cx + g + 2, cy - g + 1, 4.5, C.sun, INK);
  sparkle(ctx, cx - g - 1, cy + 2, 3, "#ffffff", INK);
}

/** Two-tone cel fill of a shape: base colour, darker lower-right, gloss strip top-left. */
function celFill(ctx: Ctx, shape: Path2D, cx: number, cy: number, b: number, base: string, shade: string, gloss = true) {
  ctx.save();
  ctx.clip(shape);
  ctx.fillStyle = base;
  ctx.fillRect(cx - b, cy - b, b * 2, b * 2);
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.moveTo(cx + b, cy - b * 0.1);
  ctx.lineTo(cx + b, cy + b);
  ctx.lineTo(cx - b * 0.2, cy + b);
  ctx.closePath();
  ctx.fill();
  if (gloss) {
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.beginPath();
    ctx.roundRect(cx - b * 0.36, cy - b * 0.42, b * 0.36, b * 0.12, b * 0.06);
    ctx.fill();
  }
  ctx.restore();
}

/** "≈" chip on the badge's top-right corner: the point is inferred (the company's only office
 * in the city), not an address the posting states. */
function inferredChip(ctx: Ctx, x: number, y: number) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 7.2, 0, Math.PI * 2);
  ctx.fillStyle = C.sun;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.lineWidth = 1.6;
  for (const dy of [-1.8, 1.8]) {
    ctx.beginPath();
    ctx.moveTo(x - 3.6, y + dy + 0.6);
    ctx.quadraticCurveTo(x - 1.8, y + dy - 1.6, x, y + dy);
    ctx.quadraticCurveTo(x + 1.8, y + dy + 1.6, x + 3.6, y + dy - 0.6);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawMarker(kind: MarkerKind, state: MarkerState, inferred = false): ImageData {
  const s = STATE_SCALE[state] * (kind === "unknown" ? 0.88 : 1);
  const b = BODY * s;
  const tip = TIP * s;
  const w = b + PAD * 2;
  const h = PAD + b + tip + GROUND;
  const [c, ctx] = canvas(w, h);
  const cx = w / 2;
  const cy = PAD + b / 2;
  const tipY = cy + b / 2 + tip;
  const col = KIND_COLORS[kind];
  const shape = badgePath(cx, cy, b, tip);

  groundShadow(ctx, cx, tipY, state === "hover" ? 9 : 7);
  if (state === "selected") selectionFrame(ctx, cx, cy, b / 2);

  // white sticker edge, then fills, then the ink line
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke(shape);

  if (kind === "on_site") {
    celFill(ctx, shape, cx, cy, b, col.base, col.shade);
  } else if (kind === "hybrid") {
    celFill(ctx, shape, cx, cy, b, col.tint, "#c4eedd", false);
    ctx.save();
    ctx.clip(shape);
    ctx.beginPath();
    ctx.rect(0, 0, cx, h);
    ctx.clip();
    celFill(ctx, shape, cx, cy, b, col.base, col.shade);
    ctx.restore();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = INK;
    ctx.beginPath();
    ctx.moveTo(cx, cy - b / 2);
    ctx.lineTo(cx, cy + b / 2);
    ctx.stroke();
  } else {
    celFill(ctx, shape, cx, cy, b, col.tint, kind === "remote" ? "#efe9ff" : "#efe7d6", false);
  }

  ctx.lineWidth = 2.4;
  ctx.strokeStyle = INK;
  ctx.stroke(shape);

  if (kind === "remote" || kind === "unknown") {
    // inner ring: thick and solid for remote (hollow look), dashed for "not stated"
    ctx.save();
    ctx.translate(cx, cy);
    const k = 0.7;
    ctx.scale(k, k);
    ctx.translate(-cx, -cy);
    ctx.lineWidth = (kind === "remote" ? 3.4 : 1.8) / k;
    if (kind === "unknown") ctx.setLineDash([3.2 / k, 2.6 / k]);
    ctx.strokeStyle = kind === "remote" ? col.base : INK;
    ctx.stroke(badgePath(cx, cy, b, tip * 0.15));
    ctx.restore();
  }

  const gs = b * (kind === "remote" ? 0.48 : kind === "unknown" ? 0.56 : 0.6);
  if (kind === "hybrid") {
    // the glyph changes colour across the split, so both halves stay legible
    for (const [x0, color] of [[0, col.glyph], [cx, col.shade]] as const) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, cx, h);
      ctx.clip();
      drawGlyph(ctx, GLYPHS.hybrid, cx, cy + 0.5, gs, color);
      ctx.restore();
    }
  } else {
    const glyph = kind === "on_site" ? GLYPHS.onSite : kind === "remote" ? GLYPHS.remote : GLYPHS.unknown;
    drawGlyph(ctx, glyph, cx, cy + 0.5, gs, kind === "unknown" ? col.shade : col.glyph);
  }
  if (inferred) inferredChip(ctx, cx + b / 2 - 1, cy - b / 2 + 1);
  return imageOf(c);
}

const STACK_CARDS = [C.sun, C.sakura, C.sky];

/** Several jobs at one address: a fan of coloured cards behind an ink badge (count = map text). */
export function drawStack(state: MarkerState): ImageData {
  const s = STATE_SCALE[state];
  const b = BODY * s;
  const tip = TIP * s;
  const w = b + PAD * 2;
  const h = PAD + b + tip + GROUND;
  const [c, ctx] = canvas(w, h);
  const cx = w / 2;
  const cy = PAD + b / 2;
  groundShadow(ctx, cx, cy + b / 2 + tip, 8);
  if (state === "selected") selectionFrame(ctx, cx, cy, b / 2 + 2);
  STACK_CARDS.forEach((color, i) => {
    const off = (3 - i) * 2.6;
    const ang = ((3 - i) * 6 * Math.PI) / 180;
    ctx.save();
    ctx.translate(cx + off, cy - off);
    ctx.rotate(ang);
    ctx.translate(-(cx + off), -(cy - off));
    const back = badgePath(cx + off, cy - off, b * 0.92, 0);
    ctx.fillStyle = color;
    ctx.fill(back);
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.stroke(back);
    ctx.restore();
  });
  const shape = badgePath(cx, cy, b, tip);
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke(shape);
  celFill(ctx, shape, cx, cy, b, INK, "#1d2550");
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = INK;
  ctx.stroke(shape);
  return imageOf(c);
}

export const CLUSTER_TIERS = { s: 16, m: 20, l: 25 } as const;
export type ClusterTier = keyof typeof CLUSTER_TIERS;

/** Region cluster: sun-yellow medallion on a sky-blue navigation star, both ink-outlined. */
export function drawCluster(tier: ClusterTier): ImageData {
  const r = CLUSTER_TIERS[tier];
  const size = (r + 15) * 2;
  const [c, ctx] = canvas(size, size);
  const cx = size / 2;
  const cy = size / 2;
  const star = new Path2D();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    const rr = i % 2 === 0 ? r + 13 : r * 0.62;
    const x = cx + rr * Math.cos(a);
    const y = cy + rr * Math.sin(a);
    if (i === 0) star.moveTo(x, y);
    else star.lineTo(x, y);
  }
  star.closePath();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke(star);
  ctx.fillStyle = C.sky;
  ctx.fill(star);
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke(star);

  const plate = new Path2D();
  plate.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke(plate);
  celFill(ctx, plate, cx, cy, r * 1.4, C.sun, "#f5b800");
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = INK;
  ctx.stroke(plate);
  ctx.beginPath();
  ctx.arc(cx, cy, r - 4.5, 0, Math.PI * 2);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.stroke();
  return imageOf(c);
}

/** Landmark stickers: Protomaps `pois.kind` → glyph + colour. */
export const LANDMARKS: Record<string, { glyph: GlyphName; color: string; glyphColor?: string }> = {
  station: { glyph: "train", color: C.sky },
  university: { glyph: "cap", color: C.sun, glyphColor: INK },
  college: { glyph: "cap", color: C.sun, glyphColor: INK },
  stadium: { glyph: "stadium", color: C.mint },
  museum: { glyph: "museum", color: C.sakura },
  gallery: { glyph: "museum", color: C.sakura },
  theatre: { glyph: "museum", color: C.sakura },
  hospital: { glyph: "cross", color: "#ffffff", glyphColor: "#ff4f6d" },
  library: { glyph: "book", color: C.lilac },
  ferry_terminal: { glyph: "anchor", color: "#2a8fe0" },
  marina: { glyph: "anchor", color: "#2a8fe0" },
  attraction: { glyph: "star", color: C.sun, glyphColor: INK },
  aquarium: { glyph: "star", color: C.sun, glyphColor: INK },
  zoo: { glyph: "star", color: C.sun, glyphColor: INK },
  theme_park: { glyph: "star", color: C.sun, glyphColor: INK },
  park: { glyph: "tree", color: C.mint },
  garden: { glyph: "tree", color: C.mint },
};

function drawLandmark(kind: string): ImageData | null {
  const lm = LANDMARKS[kind];
  if (!lm) return null;
  const [c, ctx] = canvas(30, 32);
  const cx = 15;
  const cy = 15;
  ctx.fillStyle = "rgba(43,53,102,0.3)";
  ctx.beginPath();
  ctx.arc(cx, cy + 2.5, 11.5, 0, Math.PI * 2);
  ctx.fill();
  const circle = new Path2D();
  circle.arc(cx, cy, 11.5, 0, Math.PI * 2);
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke(circle);
  ctx.fillStyle = lm.color;
  ctx.fill(circle);
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke(circle);
  drawGlyph(ctx, GLYPHS[lm.glyph], cx, cy, 14, lm.glyphColor ?? "#ffffff", 2.6);
  return imageOf(c);
}

/** A cartoon tree crown (street trees and the park texture). */
function treeCrown(ctx: Ctx, x: number, y: number, r: number) {
  const crown = new Path2D();
  crown.arc(x, y, r, 0, Math.PI * 2);
  ctx.save();
  ctx.clip(crown);
  ctx.fillStyle = "#58bf5e";
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.fillStyle = "#3e9e4f";
  ctx.beginPath();
  ctx.arc(x + r * 0.45, y + r * 0.5, r * 0.95, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#a8ec7f";
  ctx.beginPath();
  ctx.arc(x - r * 0.35, y - r * 0.4, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = "rgba(43,53,102,0.75)";
  ctx.stroke(crown);
}

function drawStreetTree(): ImageData {
  const [c, ctx] = canvas(16, 18);
  ctx.fillStyle = "rgba(43,53,102,0.25)";
  ctx.beginPath();
  ctx.ellipse(8, 16, 5, 1.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#8a5a3b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(8, 16);
  ctx.lineTo(8, 10);
  ctx.stroke();
  treeCrown(ctx, 8, 7.5, 5.8);
  return imageOf(c);
}

function drawTexture(id: string): ImageData | null {
  if (id === "tex-water") {
    // White wave crests and sparkles, sparse.
    const [c, ctx] = canvas(64, 52);
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1.6;
    for (const [x, y] of [[6, 10], [36, 34]] as const) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 4, y - 4, x + 8, y);
      ctx.quadraticCurveTo(x + 12, y - 4, x + 16, y);
      ctx.stroke();
    }
    sparkle(ctx, 52, 12, 3.2, "rgba(255,255,255,0.95)");
    sparkle(ctx, 18, 42, 2, "rgba(255,255,255,0.8)");
    return imageOf(c);
  }
  if (id === "tex-trees") {
    const [c, ctx] = canvas(36, 36);
    treeCrown(ctx, 9, 10, 5.5);
    treeCrown(ctx, 27, 27, 6.2);
    return imageOf(c);
  }
  if (id === "tex-hatch") {
    // light diagonal hatching for commercial zoning
    const [c, ctx] = canvas(12, 12);
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, 12);
    ctx.lineTo(12, 0);
    ctx.stroke();
    return imageOf(c);
  }
  return null;
}

/** City-name plate: white rounded plate, ink border, hard ink drop. Stretchable (icon-text-fit). */
function addBanner(map: MlMap) {
  const [w, h] = [48, 34];
  const [c, ctx] = canvas(w, h);
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.roundRect(2, 5, w - 4, h - 7, 13);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 8, 13);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = C.sun;
  ctx.beginPath();
  ctx.roundRect(10, h - 12, w - 20, 3, 1.5);
  ctx.fill();
  const R = PIXEL_RATIO;
  map.addImage("banner", imageOf(c), {
    pixelRatio: R,
    stretchX: [[16 * R, 32 * R]],
    stretchY: [[13 * R, 15 * R]],
    content: [12 * R, 4 * R, 36 * R, 23 * R],
  });
}

export const IMAGE_IDS: string[] = [
  ...MARKER_KINDS.flatMap((k) =>
    ["", "-inferred"].flatMap((v) => [`marker-${k}${v}`, `marker-${k}${v}-hover`, `marker-${k}${v}-selected`]),
  ),
  "stack",
  "stack-hover",
  "stack-selected",
  "cluster-s",
  "cluster-m",
  "cluster-l",
  "tex-water",
  "tex-trees",
  "tex-hatch",
  "street-tree",
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
  if (id === "street-tree") return drawStreetTree();
  if (id.startsWith("lm-")) return drawLandmark(id.slice(3));
  return drawTexture(id);
}

/** Register every image as soon as the style exists (so no tile is ever built without one),
 * and keep answering `styleimagemissing` in case the style is reloaded. */
export function provideImages(map: MlMap): void {
  const add = (id: string) => {
    if (map.hasImage(id)) return;
    const img = imageFor(id);
    if (img) map.addImage(id, img, { pixelRatio: PIXEL_RATIO });
  };
  const addAll = () => {
    IMAGE_IDS.forEach(add);
    if (!map.hasImage("banner")) addBanner(map);
  };
  map.on("styleimagemissing", (e: { id: string }) => {
    if (e.id === "banner") {
      if (!map.hasImage("banner")) addBanner(map);
    } else add(e.id);
  });
  map.once("style.load", addAll);
}
