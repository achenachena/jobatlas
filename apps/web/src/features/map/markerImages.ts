/** Marker artwork drawn on a canvas once and registered as map images. Each workplace type
 * has its own SHAPE, not just colour (DEVELOPMENT.md §10, PRD §3.3):
 *   on-site  — solid round badge
 *   hybrid   — round badge with a double ring
 *   remote   — hollow diamond (always paired with a "Remote" text label)
 *   unknown  — small solid dot
 * A "selected" variant adds a sakura glow ring. */
import type { Map as MlMap } from "maplibre-gl";

const SIZE = 56;
const PIXEL_RATIO = 2;

const COLORS = {
  on_site: "#5b4ce8",
  hybrid: "#f2589f",
  remote: "#129d9a",
  unknown: "#7d79a8",
} as const;

type Kind = keyof typeof COLORS;

function draw(kind: Kind, selected: boolean): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE * PIXEL_RATIO;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  const c = SIZE / 2;
  const color = COLORS[kind];
  if (selected) {
    ctx.beginPath();
    ctx.arc(c, c, 25, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,121,180,0.35)";
    ctx.fill();
  }
  ctx.shadowColor = "rgba(33,30,75,0.25)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  if (kind === "remote") {
    ctx.beginPath();
    ctx.moveTo(c, c - 15);
    ctx.lineTo(c + 15, c);
    ctx.lineTo(c, c + 15);
    ctx.lineTo(c - 15, c);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.stroke();
  } else if (kind === "unknown") {
    ctx.beginPath();
    ctx.arc(c, c, 9, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(c, c, 13, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    if (kind === "hybrid") {
      ctx.beginPath();
      ctx.arc(c, c, 18, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      // on-site: a small white "sparkle" in the centre for the anime-badge look
      ctx.beginPath();
      ctx.moveTo(c, c - 5);
      ctx.lineTo(c + 1.6, c - 1.6);
      ctx.lineTo(c + 5, c);
      ctx.lineTo(c + 1.6, c + 1.6);
      ctx.lineTo(c, c + 5);
      ctx.lineTo(c - 1.6, c + 1.6);
      ctx.lineTo(c - 5, c);
      ctx.lineTo(c - 1.6, c - 1.6);
      ctx.closePath();
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    }
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function registerMarkerImages(map: MlMap): void {
  for (const kind of Object.keys(COLORS) as Kind[]) {
    for (const selected of [false, true]) {
      const id = `marker-${kind}${selected ? "-selected" : ""}`;
      if (!map.hasImage(id)) map.addImage(id, draw(kind, selected), { pixelRatio: PIXEL_RATIO });
    }
  }
}
