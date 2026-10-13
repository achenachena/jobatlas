/** Hand-drawn (canvas) artwork for the map in the "Colour Manga Page" style, registered as
 * MapLibre images before any tile is built. Nothing here is a bitmap from elsewhere.
 *
 * Manga devices used: near-black ink line art, screentone dots for shading (never a darker
 * flat colour), white "shine" strokes, focus lines (集中線) around the selection, a spiky
 * shout balloon for region clusters, stacked panels for a same-address stack, and a
 * rectangular narration box for city names. Patterns: screentones and hatching for zoning,
 * ink wave curls for water, inked bushes for parks, hatch shadows for buildings.
 *
 * Job markers — an explore badge whose tip is the exact coordinate. Each workplace type
 * differs by STRUCTURE and GLYPH, never by colour alone:
 *   on-site  — solid badge, office glyph
 *   hybrid   — split badge (solid half / pale half), home + office glyph
 *   remote   — hollow badge with a thick inner ring, signal glyph
 *   unknown  — white badge, dashed inner ring, ink dot ("arrangement not stated"; the
 *              address itself is confirmed)
 * A "≈" chip marks an inferred office (the company's only office in the city). */
import type { Map as MlMap } from "maplibre-gl";

import { GLYPHS, type Glyph, type GlyphName } from "../../theme/glyphs";
import { C, INK, KIND_COLORS, type MarkerKind, PAPER } from "../../theme/palette";

const PIXEL_RATIO = 2;
const BODY = 32; // badge body edge at scale 1
const TIP = 8; // pin tip length
const GROUND = 4; // contact shadow below the tip

/** Pixels from the coordinate (tip) up to the badge centre at scale 1. */
export const BADGE_CENTER_OFFSET = TIP + BODY / 2;

export const MARKER_KINDS: MarkerKind[] = ["on_site", "hybrid", "remote", "unknown"];
export type MarkerState = "default" | "hover" | "selected";
const STATE_SCALE: Record<MarkerState, number> = { default: 1, hover: 1.1, selected: 1.2 };
/** Margin around the badge: the selection draws focus lines out to here. */
const PAD: Record<MarkerState, number> = { default: 8, hover: 8, selected: 30 };
/** Image margin below the tip (contact shadow; focus lines when selected). */
const below = (state: MarkerState) => (state === "selected" ? PAD.selected : GROUND);
/** Each marker image extends `below(state)` px under its tip; with icon-anchor "bottom" the
 * layers shift the image down by this much so the tip sits exactly on the coordinate. */
export const MARKER_ICON_OFFSET: Record<MarkerState, [number, number]> = {
  default: [0, below("default")],
  hover: [0, below("hover")],
  selected: [0, below("selected")],
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

/** Deterministic pseudo-random, so the artwork is identical on every load. */
function rand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Rounded badge body + pin tip, centred on (cx, cy). */
function badgePath(cx: number, cy: number, b: number, tip: number): Path2D {
  const p = new Path2D();
  const h = b / 2;
  const r = b * 0.3;
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

/** Screentone: a dot grid (45° rotated, like printed tone) over the current clip. */
function screentone(ctx: Ctx, x: number, y: number, w: number, h: number, step: number, radius: number, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  for (let row = 0, py = y; py < y + h + step; row++, py += step * 0.5) {
    for (let px = x + (row % 2 ? step / 2 : 0); px < x + w + step; px += step) {
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Tone shading on the lower-right of a shape (where a darker cel would be). */
function toneShade(ctx: Ctx, shape: Path2D, cx: number, cy: number, b: number, color: string) {
  ctx.save();
  ctx.clip(shape);
  ctx.beginPath();
  ctx.moveTo(cx + b, cy - b * 0.15);
  ctx.lineTo(cx + b, cy + b);
  ctx.lineTo(cx - b * 0.25, cy + b);
  ctx.closePath();
  ctx.clip();
  screentone(ctx, cx - b, cy - b, b * 2, b * 2, 3.4, 0.85, color);
  ctx.restore();
}

/** Two short white "shine" strokes, top-left. */
function shine(ctx: Ctx, cx: number, cy: number, b: number) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - b * 0.36, cy - b * 0.2);
  ctx.lineTo(cx - b * 0.36, cy - b * 0.32);
  ctx.quadraticCurveTo(cx - b * 0.36, cy - b * 0.38, cx - b * 0.28, cy - b * 0.38);
  ctx.moveTo(cx - b * 0.12, cy - b * 0.38);
  ctx.lineTo(cx - b * 0.06, cy - b * 0.38);
  ctx.stroke();
  ctx.restore();
}

/** Focus lines (集中線): tapered ink strokes converging on the badge. */
function focusLines(ctx: Ctx, cx: number, cy: number, inner: number, outer: number) {
  const r = rand(7);
  ctx.save();
  ctx.fillStyle = INK;
  const n = 34;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.12;
    const start = inner + r() * 6;
    const end = outer - r() * 8;
    const w = 0.9 + r() * 1.6;
    const [ca, sa] = [Math.cos(a), Math.sin(a)];
    ctx.beginPath();
    ctx.moveTo(cx + ca * start, cy + sa * start);
    ctx.lineTo(cx + ca * end - sa * w, cy + sa * end + ca * w);
    ctx.lineTo(cx + ca * end + sa * w, cy + sa * end - ca * w);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function groundShadow(ctx: Ctx, cx: number, y: number, w: number) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, y, w, w * 0.3, 0, 0, Math.PI * 2);
  ctx.clip();
  screentone(ctx, cx - w, y - w, w * 2, w * 2, 2.6, 0.8, INK);
  ctx.restore();
}

/** "≈" chip: the point is inferred (the company's only office in the city). */
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
  const s = STATE_SCALE[state] * (kind === "unknown" ? 0.9 : 1);
  const b = BODY * s;
  const tip = TIP * s;
  const pad = PAD[state];
  const w = b + pad * 2;
  const h = pad + b + tip + below(state);
  const [c, ctx] = canvas(w, h);
  const cx = w / 2;
  const cy = pad + b / 2;
  const col = KIND_COLORS[kind];
  const shape = badgePath(cx, cy, b, tip);

  if (state === "selected") focusLines(ctx, cx, cy, b * 0.78, Math.min(cx, cy) + b * 0.1);
  groundShadow(ctx, cx, cy + b / 2 + tip, state === "hover" ? 9 : 7);

  // paper edge, so the badge separates from any background
  ctx.lineWidth = 6;
  ctx.strokeStyle = PAPER;
  ctx.stroke(shape);

  ctx.save();
  ctx.clip(shape);
  if (kind === "hybrid") {
    ctx.fillStyle = col.tint;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = col.base;
    ctx.fillRect(0, 0, cx, h);
  } else {
    ctx.fillStyle = kind === "on_site" ? col.base : col.tint;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
  toneShade(ctx, shape, cx, cy, b, kind === "on_site" || kind === "hybrid" ? "rgba(23,21,31,0.55)" : C.toneLight);

  ctx.lineWidth = state === "default" ? 2.6 : 3;
  ctx.strokeStyle = INK;
  ctx.stroke(shape);
  if (kind === "hybrid") {
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(cx, cy - b / 2);
    ctx.lineTo(cx, cy + b / 2);
    ctx.stroke();
  }

  if (kind === "remote" || kind === "unknown") {
    ctx.save();
    ctx.translate(cx, cy);
    const k = 0.7;
    ctx.scale(k, k);
    ctx.translate(-cx, -cy);
    ctx.lineWidth = (kind === "remote" ? 3.6 : 1.8) / k;
    if (kind === "unknown") ctx.setLineDash([3.2 / k, 2.6 / k]);
    ctx.strokeStyle = kind === "remote" ? col.base : INK;
    ctx.stroke(badgePath(cx, cy, b, tip * 0.15));
    ctx.restore();
  }

  const gs = b * (kind === "remote" ? 0.48 : kind === "unknown" ? 0.5 : 0.6);
  if (kind === "hybrid") {
    for (const [x0, color] of [[0, col.glyph], [cx, INK]] as const) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, cx, h);
      ctx.clip();
      drawGlyph(ctx, GLYPHS.hybrid, cx, cy + 0.5, gs, color);
      ctx.restore();
    }
  } else {
    const glyph = kind === "on_site" ? GLYPHS.onSite : kind === "remote" ? GLYPHS.remote : GLYPHS.unknown;
    drawGlyph(ctx, glyph, cx, cy + 0.5, gs, col.glyph);
  }
  if (kind === "on_site" || kind === "hybrid") shine(ctx, cx, cy, b);
  if (inferred) inferredChip(ctx, cx + b / 2 - 1, cy - b / 2 + 1);
  return imageOf(c);
}

const PANEL_TONES = [C.sun, C.sakura, C.sky];

/** Several jobs at one address: a stack of tilted manga panels behind an ink badge. */
export function drawStack(state: MarkerState): ImageData {
  const s = STATE_SCALE[state];
  const b = BODY * s;
  const tip = TIP * s;
  const pad = Math.max(PAD[state], 12);
  const w = b + pad * 2;
  const h = pad + b + tip + below(state);
  const [c, ctx] = canvas(w, h);
  const cx = w / 2;
  const cy = pad + b / 2;
  if (state === "selected") focusLines(ctx, cx, cy, b * 0.82, Math.min(cx, cy) + b * 0.1);
  groundShadow(ctx, cx, cy + b / 2 + tip, 8);
  PANEL_TONES.forEach((color, i) => {
    const off = (3 - i) * 2.8;
    ctx.save();
    ctx.translate(cx + off, cy - off);
    ctx.rotate(((3 - i) * 7 * Math.PI) / 180);
    const half = b * 0.46;
    ctx.fillStyle = PAPER;
    ctx.fillRect(-half, -half, half * 2, half * 2);
    ctx.beginPath();
    ctx.rect(-half, -half, half * 2, half * 2);
    ctx.save();
    ctx.clip();
    screentone(ctx, -half, -half, half * 2, half * 2, 3.2, 1, color);
    ctx.restore();
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.strokeRect(-half, -half, half * 2, half * 2);
    ctx.restore();
  });
  const shape = badgePath(cx, cy, b, tip);
  ctx.lineWidth = 6;
  ctx.strokeStyle = PAPER;
  ctx.stroke(shape);
  ctx.fillStyle = INK;
  ctx.fill(shape);
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = INK;
  ctx.stroke(shape);
  return imageOf(c);
}

export const CLUSTER_TIERS = { s: 17, m: 21, l: 26 } as const;
export type ClusterTier = keyof typeof CLUSTER_TIERS;

/** Region cluster: a spiky shout balloon (sun yellow, ink outline, hard ink drop). No tip:
 * it stands for an area, not a point. */
export function drawCluster(tier: ClusterTier): ImageData {
  const r = CLUSTER_TIERS[tier];
  const size = (r + 14) * 2;
  const [c, ctx] = canvas(size, size);
  const cx = size / 2;
  const cy = size / 2;
  const rnd = rand(r * 13);
  const burst = new Path2D();
  const n = 14;
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? r + 9 + rnd() * 3 : r - 1 + rnd() * 2;
    const x = cx + rr * Math.cos(a);
    const y = cy + rr * Math.sin(a);
    if (i === 0) burst.moveTo(x, y);
    else burst.lineTo(x, y);
  }
  burst.closePath();
  ctx.lineJoin = "miter";
  ctx.save();
  ctx.translate(2.5, 3);
  ctx.fillStyle = INK;
  ctx.fill(burst);
  ctx.restore();
  ctx.fillStyle = C.sun;
  ctx.fill(burst);
  ctx.save();
  ctx.clip(burst);
  ctx.beginPath();
  ctx.moveTo(cx + r * 2, cy - r * 0.2);
  ctx.lineTo(cx + r * 2, cy + r * 2);
  ctx.lineTo(cx - r * 0.4, cy + r * 2);
  ctx.closePath();
  ctx.clip();
  screentone(ctx, 0, 0, size, size, 3.6, 1.05, "rgba(23,21,31,0.45)");
  ctx.restore();
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = INK;
  ctx.stroke(burst);
  return imageOf(c);
}

/** Landmark stickers: Protomaps `pois.kind` → glyph + spot colour. */
export const LANDMARKS: Record<string, { glyph: GlyphName; color: string; glyphColor?: string }> = {
  station: { glyph: "train", color: C.sky },
  university: { glyph: "cap", color: C.sun, glyphColor: INK },
  college: { glyph: "cap", color: C.sun, glyphColor: INK },
  stadium: { glyph: "stadium", color: C.mint, glyphColor: INK },
  museum: { glyph: "museum", color: C.sakura },
  gallery: { glyph: "museum", color: C.sakura },
  theatre: { glyph: "museum", color: C.sakura },
  hospital: { glyph: "cross", color: PAPER, glyphColor: C.sakura },
  library: { glyph: "book", color: C.lilac },
  ferry_terminal: { glyph: "anchor", color: C.skyDeep },
  marina: { glyph: "anchor", color: C.skyDeep },
  attraction: { glyph: "star", color: C.sun, glyphColor: INK },
  aquarium: { glyph: "star", color: C.sun, glyphColor: INK },
  zoo: { glyph: "star", color: C.sun, glyphColor: INK },
  theme_park: { glyph: "star", color: C.sun, glyphColor: INK },
  park: { glyph: "tree", color: C.mint, glyphColor: INK },
  garden: { glyph: "tree", color: C.mint, glyphColor: INK },
};

function drawLandmark(kind: string): ImageData | null {
  const lm = LANDMARKS[kind];
  if (!lm) return null;
  const [c, ctx] = canvas(30, 32);
  const cx = 14;
  const cy = 14;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(cx + 2, cy + 2.5, 11.5, 0, Math.PI * 2);
  ctx.fill();
  const circle = new Path2D();
  circle.arc(cx, cy, 11.5, 0, Math.PI * 2);
  ctx.fillStyle = lm.color;
  ctx.fill(circle);
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = INK;
  ctx.stroke(circle);
  drawGlyph(ctx, GLYPHS[lm.glyph], cx, cy, 14, lm.glyphColor ?? "#ffffff", 2.6);
  return imageOf(c);
}

/** An inked bush: three overlapping white puffs with an ink outline and a few tone dots. */
function bush(ctx: Ctx, x: number, y: number, r: number, fill = "#ffffff") {
  const puffs: Array<[number, number, number]> = [
    [x - r * 0.45, y + r * 0.1, r * 0.62],
    [x + r * 0.45, y + r * 0.12, r * 0.6],
    [x, y - r * 0.32, r * 0.7],
  ];
  const p = new Path2D();
  for (const [px, py, pr] of puffs) {
    p.moveTo(px + pr, py);
    p.arc(px, py, pr, 0, Math.PI * 2);
  }
  ctx.save();
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = INK;
  ctx.stroke(p);
  ctx.fillStyle = fill;
  ctx.fill(p);
  ctx.clip(p);
  screentone(ctx, x, y - r * 0.1, r, r, 2.6, 0.75, "rgba(23,21,31,0.6)");
  ctx.restore();
}

function drawStreetTree(): ImageData {
  const [c, ctx] = canvas(18, 20);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(9, 18);
  ctx.lineTo(9, 11);
  ctx.stroke();
  bush(ctx, 9, 8, 6.2);
  return imageOf(c);
}

/** Horizontal speed lines with random gaps — the manga way to draw water. */
function waterLines(ctx: Ctx, w: number, h: number, seed: number) {
  const r = rand(seed);
  ctx.strokeStyle = "rgba(23,21,31,0.55)";
  ctx.lineCap = "round";
  for (let y = 3; y < h; y += 5) {
    let x = -r() * 20;
    while (x < w) {
      const len = 6 + r() * 22;
      ctx.lineWidth = 0.7 + r() * 0.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(Math.min(x + len, w + 2), y);
      ctx.stroke();
      x += len + 3 + r() * 10;
    }
  }
}

function drawTexture(id: string): ImageData | null {
  switch (id) {
    case "tone-light": {
      // fine 10% screentone (residential)
      const [c, ctx] = canvas(6, 6);
      screentone(ctx, 0, 0, 6, 6, 6, 0.7, "rgba(23,21,31,0.45)");
      return imageOf(c);
    }
    case "tone-pink": {
      // coarse 25% screentone (commercial / retail: the busy downtown reads darker)
      const [c, ctx] = canvas(6, 6);
      screentone(ctx, 0, 0, 6, 6, 6, 1.25, "rgba(23,21,31,0.6)");
      return imageOf(c);
    }
    case "tone-lines": {
      // diagonal hatching (industrial)
      const [c, ctx] = canvas(7, 7);
      ctx.strokeStyle = "rgba(23,21,31,0.5)";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-1, 8);
      ctx.lineTo(8, -1);
      ctx.stroke();
      return imageOf(c);
    }
    case "tone-sun": {
      // cross-hatching (campuses)
      const [c, ctx] = canvas(8, 8);
      ctx.strokeStyle = "rgba(23,21,31,0.35)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-1, 9);
      ctx.lineTo(9, -1);
      ctx.moveTo(-1, -1);
      ctx.lineTo(9, 9);
      ctx.stroke();
      return imageOf(c);
    }
    case "hatch-shadow": {
      // dense ink hatching for building shadows
      const [c, ctx] = canvas(4, 4);
      ctx.strokeStyle = "rgba(23,21,31,0.85)";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-1, 5);
      ctx.lineTo(5, -1);
      ctx.stroke();
      return imageOf(c);
    }
    case "tex-trees": {
      const [c, ctx] = canvas(36, 36);
      bush(ctx, 9, 11, 7);
      bush(ctx, 27, 28, 8);
      return imageOf(c);
    }
    case "tex-water": {
      const [c, ctx] = canvas(96, 60);
      waterLines(ctx, 96, 60, 19);
      return imageOf(c);
    }
    case "tone-band": {
      // dense dark tone along the shore (line-pattern), like a shaded water edge
      const [c, ctx] = canvas(6, 12);
      screentone(ctx, 0, 0, 6, 12, 4, 1.15, "rgba(23,21,31,0.7)");
      return imageOf(c);
    }
    case "paper": {
      const [c, ctx] = canvas(64, 64);
      const r = rand(3);
      ctx.fillStyle = "rgba(60,55,50,0.07)";
      for (let i = 0; i < 70; i++) {
        ctx.beginPath();
        ctx.arc(r() * 64, r() * 64, 0.4 + r() * 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      return imageOf(c);
    }
    default:
      return null;
  }
}

/** Speech balloon for district names: white oval, ink outline, small tail. Stretchable. */
function addBubble(map: MlMap) {
  const [w, h] = [52, 34];
  const [c, ctx] = canvas(w, h);
  const body = new Path2D();
  body.roundRect(2, 2, w - 4, h - 11, 12);
  body.moveTo(w / 2 - 6, h - 9.5);
  body.lineTo(w / 2 - 9, h - 2);
  body.lineTo(w / 2 + 3, h - 9.5);
  ctx.fillStyle = "#ffffff";
  ctx.fill(body);
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = INK;
  ctx.stroke(body);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(w / 2 - 6.4, h - 11.5, 9.6, 3); // open the outline where the tail joins
  const R = PIXEL_RATIO;
  map.addImage("bubble", imageOf(c), {
    pixelRatio: R,
    stretchX: [[12 * R, 17 * R], [35 * R, 40 * R]],
    stretchY: [[10 * R, 13 * R]],
    content: [8 * R, 4 * R, 44 * R, 21 * R],
  });
}

/** City-name narration box: square white box, ink border, hard ink drop. Stretchable. */
function addCaption(map: MlMap) {
  const [w, h] = [44, 30];
  const [c, ctx] = canvas(w, h);
  ctx.fillStyle = C.red;
  ctx.fillRect(5, 5, w - 6, h - 6);
  ctx.fillStyle = INK;
  ctx.fillRect(1.5, 1.5, w - 7, h - 7);
  const R = PIXEL_RATIO;
  map.addImage("banner", imageOf(c), {
    pixelRatio: R,
    stretchX: [[10 * R, 30 * R]],
    stretchY: [[10 * R, 16 * R]],
    content: [8 * R, 5 * R, 32 * R, 20 * R],
  });
}

// ------------------------------------------------------------------ 2.5D towers

/** Height tiers for the standing tower drawings (metres of the real building → sprite px). */
export const TOWER_TIERS: Array<{ id: string; minHeight: number; h: number }> = [
  { id: "t1", minHeight: 60, h: 54 },
  { id: "t2", minHeight: 100, h: 82 },
  { id: "t3", minHeight: 160, h: 116 },
  { id: "t4", minHeight: 240, h: 160 },
];
/** Building archetypes, picked per building from its real height (deterministic). */
export const TOWER_VARIANTS = 8;

/** Oblique depth of side faces and roofs (the fixed 2.5D projection, light from the left). */
const DEPTH = { side: 0.36, roof: 0.22 };
const OUTLINE = 2.2; // contour weight
const FINE = 0.8; // interior line weight

type WindowStyle = "grid" | "ribbon" | "glass" | "balcony" | "none";

/** One box drawn the manga way. (x, ground) is the front face's bottom-left corner. The side
 * face (right) is spot black with thin white window lines; the roof is screentone; the front
 * face is white paper with the chosen window treatment. Returns the roof's front-left corner. */
function box(ctx: Ctx, x: number, ground: number, w: number, h: number, style: WindowStyle, r: () => number,
             opts: { round?: boolean; slant?: number } = {}) {
  const sd = Math.max(4, w * DEPTH.side);
  const rd = Math.max(3, w * DEPTH.roof);
  const top = ground - h;
  const slant = opts.slant ?? 0; // roof cut: the right edge is this much lower

  // side face: solid ink, white window slits
  const side = new Path2D();
  side.moveTo(x + w, ground);
  side.lineTo(x + w + sd, ground - rd);
  side.lineTo(x + w + sd, top + slant - rd);
  side.lineTo(x + w, top + slant);
  side.closePath();
  ctx.fillStyle = INK;
  ctx.fill(side);
  if (style !== "none") {
    ctx.save();
    ctx.clip(side);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 0.7;
    const step = style === "ribbon" ? 6 : 4.5;
    for (let y = top + slant + 5; y < ground - 3; y += step) {
      ctx.beginPath();
      ctx.moveTo(x + w + 1.5, y);
      ctx.lineTo(x + w + sd - 1.5, y - rd + 1);
      ctx.stroke();
    }
    ctx.restore();
  }

  // front face
  const front = new Path2D();
  front.moveTo(x, ground);
  front.lineTo(x + w, ground);
  front.lineTo(x + w, top + slant);
  front.lineTo(x, top);
  front.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill(front);
  ctx.save();
  ctx.clip(front);
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = FINE;
  if (style === "grid") {
    const cols = Math.max(2, Math.round(w / 6));
    const cw = w / cols;
    for (let y = top + 4; y < ground - 5; y += 6) {
      for (let i = 0; i < cols; i++) {
        const wx = x + i * cw + cw * 0.22;
        const lit = r();
        if (lit < 0.28) ctx.fillRect(wx, y, cw * 0.56, 3.2); // dark window (spot black)
        else ctx.strokeRect(wx, y, cw * 0.56, 3.2);
      }
    }
  } else if (style === "ribbon") {
    for (let y = top + 5; y < ground - 4; y += 6) ctx.fillRect(x + 1.5, y, w - 3, 2.6);
    ctx.fillStyle = "#ffffff";
    for (let y = top + 5; y < ground - 4; y += 6) ctx.fillRect(x + w * 0.62, y, 2, 2.6); // highlight
  } else if (style === "glass") {
    const cols = Math.max(3, Math.round(w / 5));
    for (let i = 1; i < cols; i++) {
      const lx = x + (w * i) / cols;
      ctx.beginPath();
      ctx.moveTo(lx, top);
      ctx.lineTo(lx, ground);
      ctx.stroke();
    }
    // screentone on the left third, white reflection streaks across
    screentone(ctx, x, top, w * 0.35, h, 3, 0.6, "rgba(23,21,31,0.55)");
    ctx.fillStyle = "#ffffff";
    for (const [a, b] of [[0.15, 0.32], [0.42, 0.5]] as const) {
      ctx.beginPath();
      ctx.moveTo(x + w * (a + 0.35), top);
      ctx.lineTo(x + w * (b + 0.35), top);
      ctx.lineTo(x + w * b - w * 0.2, ground);
      ctx.lineTo(x + w * a - w * 0.2, ground);
      ctx.fill();
    }
  } else if (style === "balcony") {
    for (let y = top + 6; y < ground - 4; y += 7) {
      ctx.fillRect(x + 1, y + 3.2, w - 2, 1.1); // slab edge
      ctx.beginPath();
      ctx.moveTo(x + 1, y);
      ctx.lineTo(x + w - 1, y);
      ctx.stroke(); // railing
      for (let i = 2; i < w - 2; i += 3) ctx.fillRect(x + i, y, 0.5, 3.2); // balusters
    }
  }
  // soft rounding: a curved tone band on the left edge
  if (opts.round) screentone(ctx, x, top, w * 0.22, h, 2.6, 0.8, "rgba(23,21,31,0.7)");
  ctx.restore();

  // roof: screentone parallelogram
  const roof = new Path2D();
  roof.moveTo(x, top);
  roof.lineTo(x + sd, top - rd);
  roof.lineTo(x + w + sd, top + slant - rd);
  roof.lineTo(x + w, top + slant);
  roof.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill(roof);
  ctx.save();
  ctx.clip(roof);
  screentone(ctx, x, top - rd, w + sd, rd + Math.abs(slant), 2.4, 0.7, "rgba(23,21,31,0.65)");
  ctx.restore();

  // contour: heavy outside, fine inside edges
  ctx.strokeStyle = INK;
  ctx.lineWidth = FINE;
  ctx.beginPath();
  ctx.moveTo(x + w, ground);
  ctx.lineTo(x + w, top + slant);
  ctx.lineTo(x, top);
  ctx.stroke();
  ctx.lineWidth = OUTLINE;
  ctx.beginPath();
  ctx.moveTo(x, ground);
  ctx.lineTo(x, top);
  ctx.lineTo(x + sd, top - rd);
  ctx.lineTo(x + w + sd, top + slant - rd);
  ctx.lineTo(x + w + sd, ground - rd);
  ctx.lineTo(x + w, ground);
  ctx.closePath();
  ctx.stroke();
  return { roofX: x, roofY: top, sd, rd };
}

/** Four-point sparkle, optionally with an ink rim. */
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

/** A white four-point sparkle with an ink rim (glints on glass). */
function glint(ctx: Ctx, x: number, y: number, r: number) {
  sparkle(ctx, x, y, r, "#ffffff", INK);
}

/** Rooftop water tank on legs (classic city-roof detail). */
function waterTank(ctx: Ctx, x: number, y: number) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  for (const lx of [x + 1, x + 6]) {
    ctx.beginPath();
    ctx.moveTo(lx, y);
    ctx.lineTo(lx, y - 4);
    ctx.stroke();
  }
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(x + 3.5, y - 9, 4.2, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.fillRect(x + 4.5, y - 13, 3, 8);
  ctx.beginPath();
  ctx.moveTo(x - 1, y - 13.5);
  ctx.lineTo(x + 3.5, y - 17);
  ctx.lineTo(x + 8, y - 13.5);
  ctx.stroke();
}

function beacon(ctx: Ctx, x: number, yTop: number, len: number) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(x, yTop + len);
  ctx.lineTo(x, yTop);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 2.5, yTop + len * 0.45);
  ctx.lineTo(x + 2.5, yTop + len * 0.45);
  ctx.stroke();
  ctx.fillStyle = C.red;
  ctx.beginPath();
  ctx.arc(x, yTop, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Tall buildings as manga drawings stood up on the map (2.5D). Eight archetypes; the bottom
 * centre of the image is the building's footprint point. */
function drawTower(tierId: string, variant: number): ImageData | null {
  const tier = TOWER_TIERS.find((t) => t.id === tierId);
  if (!tier) return null;
  const h = tier.h;
  const r = rand(variant * 131 + h);
  const W = 64;
  const H = h + 50;
  const [c, ctx] = canvas(W, H);
  ctx.lineJoin = "miter";
  const ground = H - 3;
  const mid = W / 2;
  const ground_shadow = () => {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(mid + 4, ground, 22, 3.5, 0, 0, Math.PI * 2);
    ctx.clip();
    screentone(ctx, mid - 20, ground - 4, 48, 8, 2.4, 0.8, "rgba(23,21,31,0.7)");
    ctx.restore();
  };
  ground_shadow();

  switch (variant) {
    case 0: {
      // glass curtain-wall tower with a sparkle
      const w = 22;
      const x = mid - w / 2 - 3;
      box(ctx, x, ground, w, h, "glass", r);
      glint(ctx, x + w * 0.75, ground - h * 0.72, 4.5);
      break;
    }
    case 1: {
      // art-deco setbacks and a spire
      const w = 26;
      const x = mid - w / 2 - 3;
      box(ctx, x, ground, w, h * 0.6, "grid", r);
      box(ctx, x + 4, ground - h * 0.6, w - 8, h * 0.25, "grid", r);
      const t = box(ctx, x + 8, ground - h * 0.85, w - 16, h * 0.15, "ribbon", r);
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.moveTo(t.roofX + (w - 16) / 2 + t.sd / 2 - 2, t.roofY - t.rd / 2);
      ctx.lineTo(t.roofX + (w - 16) / 2 + t.sd / 2, t.roofY - t.rd / 2 - 22);
      ctx.lineTo(t.roofX + (w - 16) / 2 + t.sd / 2 + 2, t.roofY - t.rd / 2);
      ctx.fill();
      break;
    }
    case 2: {
      // ribbon-window office block with a water tank
      const w = 30;
      const x = mid - w / 2 - 4;
      const t = box(ctx, x, ground, w, h, "ribbon", r);
      waterTank(ctx, t.roofX + w * 0.55, t.roofY - t.rd * 0.4);
      break;
    }
    case 3: {
      // condo with balconies and a rounded edge
      const w = 24;
      const x = mid - w / 2 - 3;
      box(ctx, x, ground, w, h, "balcony", r, { round: true });
      break;
    }
    case 4: {
      // sliced-roof tower with a red beacon
      const w = 24;
      const x = mid - w / 2 - 3;
      const slant = Math.min(18, h * 0.22);
      const t = box(ctx, x, ground, w, h, "glass", r, { slant });
      beacon(ctx, t.roofX + 4, t.roofY - 16, 14);
      break;
    }
    case 5: {
      // cylinder: drawn as a narrow box with heavy rounding, ring lines and a domed cap
      const w = 20;
      const x = mid - w / 2 - 2;
      const t = box(ctx, x, ground, w, h, "ribbon", r, { round: true });
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = INK;
      ctx.lineWidth = OUTLINE;
      ctx.beginPath();
      ctx.ellipse(t.roofX + w / 2 + t.sd / 2, t.roofY - t.rd / 2, w / 2 + t.sd / 2, 6, 0, Math.PI, 0);
      ctx.fill();
      ctx.stroke();
      beacon(ctx, t.roofX + w / 2 + t.sd / 2, t.roofY - t.rd / 2 - 18, 12);
      break;
    }
    case 6: {
      // twin towers with a sky bridge
      const w = 13;
      const x1 = mid - 16;
      const x2 = mid + 3;
      box(ctx, x2, ground - 3, w, h * 0.9, "grid", r);
      box(ctx, x1, ground, w, h, "grid", r);
      const by = ground - h * 0.55;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x1 + w, by, x2 - x1 - w, 5);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.4;
      ctx.strokeRect(x1 + w, by, x2 - x1 - w, 5);
      break;
    }
    default: {
      // building with a big red rooftop sign
      const w = 28;
      const x = mid - w / 2 - 3;
      const t = box(ctx, x, ground, w, h, "grid", r);
      const sw = w * 0.8;
      const sh = 11;
      const sx = t.roofX + (w - sw) / 2 + t.sd * 0.4;
      const sy = t.roofY - t.rd * 0.5 - sh - 4;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      for (const lx of [sx + 3, sx + sw - 3]) {
        ctx.beginPath();
        ctx.moveTo(lx, sy + sh);
        ctx.lineTo(lx, sy + sh + 5);
        ctx.stroke();
      }
      ctx.fillStyle = C.red;
      ctx.fillRect(sx, sy, sw, sh);
      ctx.lineWidth = 1.6;
      ctx.strokeRect(sx, sy, sw, sh);
      sparkle(ctx, sx + sw / 2, sy + sh / 2, 4, "#ffffff");
      break;
    }
  }
  return imageOf(c);
}

export const TOWER_IMAGE_IDS = TOWER_TIERS.flatMap((t) =>
  Array.from({ length: TOWER_VARIANTS }, (_, v) => `tower-${t.id}-${v}`),
);

const TEXTURES = ["tone-light", "tone-pink", "tone-lines", "tone-sun", "hatch-shadow", "tex-trees", "tex-water", "tone-band", "paper"];

export const IMAGE_IDS: string[] = [
  ...TOWER_IMAGE_IDS,
  ...MARKER_KINDS.flatMap((k) =>
    ["", "-inferred"].flatMap((v) => [`marker-${k}${v}`, `marker-${k}${v}-hover`, `marker-${k}${v}-selected`]),
  ),
  "stack",
  "stack-hover",
  "stack-selected",
  "cluster-s",
  "cluster-m",
  "cluster-l",
  "street-tree",
  ...TEXTURES,
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
  const tw = /^tower-(t\d)-(\d)$/.exec(id);
  if (tw) return drawTower(tw[1]!, Number(tw[2]));
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
    if (!map.hasImage("banner")) addCaption(map);
    if (!map.hasImage("bubble")) addBubble(map);
  };
  map.on("styleimagemissing", (e: { id: string }) => {
    if (e.id === "banner") {
      if (!map.hasImage("banner")) addCaption(map);
    } else if (e.id === "bubble") {
      if (!map.hasImage("bubble")) addBubble(map);
    } else add(e.id);
  });
  map.once("style.load", addAll);
}
