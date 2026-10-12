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
  screentone(ctx, x, y - r * 0.1, r, r, 2.6, 0.7, "rgba(31,122,74,0.75)");
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

function drawTexture(id: string): ImageData | null {
  switch (id) {
    case "tone-light": {
      // ~10% grey screentone (residential)
      const [c, ctx] = canvas(8, 8);
      screentone(ctx, 0, 0, 8, 8, 8, 0.75, "rgba(23,21,31,0.35)");
      return imageOf(c);
    }
    case "tone-pink": {
      // sakura tone (commercial / retail)
      const [c, ctx] = canvas(7, 7);
      screentone(ctx, 0, 0, 7, 7, 7, 1.15, "rgba(255,92,147,0.55)");
      return imageOf(c);
    }
    case "tone-lines": {
      // diagonal hatching (industrial)
      const [c, ctx] = canvas(9, 9);
      ctx.strokeStyle = "rgba(23,21,31,0.3)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-1, 10);
      ctx.lineTo(10, -1);
      ctx.stroke();
      return imageOf(c);
    }
    case "tone-sun": {
      // sun-yellow tone (schools / campuses)
      const [c, ctx] = canvas(7, 7);
      screentone(ctx, 0, 0, 7, 7, 7, 1.3, "rgba(240,180,0,0.6)");
      return imageOf(c);
    }
    case "hatch-shadow": {
      // dense ink hatching for building shadows
      const [c, ctx] = canvas(5, 5);
      ctx.strokeStyle = "rgba(23,21,31,0.55)";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-1, 6);
      ctx.lineTo(6, -1);
      ctx.stroke();
      return imageOf(c);
    }
    case "tex-trees": {
      const [c, ctx] = canvas(40, 40);
      bush(ctx, 10, 12, 7, "#e9fbe9");
      bush(ctx, 30, 30, 8, "#e9fbe9");
      return imageOf(c);
    }
    case "tex-water": {
      // manga wave curls in ink-blue, sparse
      const [c, ctx] = canvas(72, 56);
      ctx.strokeStyle = "rgba(23,105,224,0.55)";
      ctx.lineWidth = 1.5;
      for (const [x, y] of [[8, 14], [42, 40]] as const) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + 6, y - 7, x + 12, y);
        ctx.arc(x + 9.5, y - 1.5, 2.6, 0.2, Math.PI * 1.5, true);
        ctx.moveTo(x + 12, y);
        ctx.quadraticCurveTo(x + 18, y + 4, x + 24, y);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      for (const [x, y] of [[58, 12], [24, 46]] as const) {
        ctx.beginPath();
        ctx.arc(x, y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
      return imageOf(c);
    }
    case "tone-band": {
      // halftone band hugging the shore (used as a line-pattern)
      const [c, ctx] = canvas(8, 12);
      screentone(ctx, 0, 0, 8, 12, 4, 1, "rgba(23,105,224,0.5)");
      return imageOf(c);
    }
    case "paper": {
      // faint paper grain over the whole land
      const [c, ctx] = canvas(64, 64);
      const r = rand(3);
      ctx.fillStyle = "rgba(120,100,60,0.09)";
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

/** City-name narration box: square white box, ink border, hard ink drop. Stretchable. */
function addCaption(map: MlMap) {
  const [w, h] = [44, 30];
  const [c, ctx] = canvas(w, h);
  ctx.fillStyle = INK;
  ctx.fillRect(5, 5, w - 6, h - 6);
  ctx.fillStyle = PAPER;
  ctx.fillRect(1.5, 1.5, w - 7, h - 7);
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = INK;
  ctx.strokeRect(1.5, 1.5, w - 7, h - 7);
  const R = PIXEL_RATIO;
  map.addImage("banner", imageOf(c), {
    pixelRatio: R,
    stretchX: [[10 * R, 30 * R]],
    stretchY: [[10 * R, 16 * R]],
    content: [8 * R, 5 * R, 32 * R, 20 * R],
  });
}

const TEXTURES = ["tone-light", "tone-pink", "tone-lines", "tone-sun", "hatch-shadow", "tex-trees", "tex-water", "tone-band", "paper"];

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
  };
  map.on("styleimagemissing", (e: { id: string }) => {
    if (e.id === "banner") {
      if (!map.hasImage("banner")) addCaption(map);
    } else add(e.id);
  });
  map.once("style.load", addAll);
}
