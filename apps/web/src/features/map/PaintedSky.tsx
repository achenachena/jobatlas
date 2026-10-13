/** Hand-painted summer sky behind the map (the map canvas is transparent above its horizon).
 *
 * Anime-background sky: deep summer blue at the top, fading to a warm pale horizon; a soft sun
 * glow; towering cumulus near the horizon and smaller clouds higher up, each painted from many
 * soft dabs — warm white tops, cool blue-violet undersides, a warm sunlit rim. Painted once per
 * size (deterministic); the map shifts it sideways when it rotates (parallax). */
import { useEffect, useRef } from "react";

import { rand } from "./markerImages";

type Ctx = CanvasRenderingContext2D;

type Billow = [number, number, number]; // x, y, radius

function union(billows: Billow[], dx = 0, dy = 0, k = 1): Path2D {
  const p = new Path2D();
  for (const [x, y, r] of billows) {
    p.moveTo(x + dx + r * k, y + dy);
    p.arc(x + dx, y + dy, r * k, 0, Math.PI * 2);
  }
  return p;
}

/** One anime cumulus: a single crisp silhouette (merged billows) with a flat base, painted in
 * three layers — cool blue-violet underside, white body lifted up, warm-white sunlit tops. */
function cumulus(ctx: Ctx, cx: number, baseY: number, width: number, height: number, r: () => number) {
  const billows: Billow[] = [];
  const n = Math.round(4 + width / 70);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const bell = Math.sin(Math.PI * (0.08 + 0.84 * t));
    const rad = (width / n) * (0.9 + r() * 0.7) * (0.7 + bell * 0.9);
    const x = cx - width / 2 + t * width + (r() - 0.5) * (width / n) * 0.6;
    const y = baseY - rad * 0.55 - bell * height * (0.35 + r() * 0.5);
    billows.push([x, y, rad]);
    if (bell > 0.7 && r() < 0.5) billows.push([x + (r() - 0.5) * rad * 0.6, y - rad * 0.55, rad * (0.7 + r() * 0.2)]);
  }
  ctx.save();
  // flat base: nothing below baseY
  const clip = new Path2D();
  clip.rect(cx - width, baseY - height * 3, width * 2, height * 3);
  ctx.clip(clip);
  const shape = union(billows);
  ctx.fillStyle = "#c3cdef";
  ctx.fill(shape);
  ctx.clip(shape);
  // body lifted up: the underside stays as a cool band along the bottom of every billow
  ctx.fillStyle = "#f6f7ff";
  ctx.fill(union(billows, -width * 0.012, -height * 0.13, 0.96));
  // warm sunlit rim on the upper-right of the billows
  ctx.fillStyle = "#fffaee";
  ctx.fill(union(billows, width * 0.02, -height * 0.2, 0.88));
  // soft blue shading at the flat base
  const g = ctx.createLinearGradient(0, baseY - height * 0.35, 0, baseY);
  g.addColorStop(0, "rgba(150,165,225,0)");
  g.addColorStop(1, "rgba(150,165,225,0.55)");
  ctx.fillStyle = g;
  ctx.fillRect(cx - width, baseY - height * 0.35, width * 2, height * 0.35);
  ctx.restore();
}

export function paintSky(canvas: HTMLCanvasElement, width: number, height: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#2f7fe0");
  sky.addColorStop(0.35, "#5aa9f2");
  sky.addColorStop(0.75, "#9fd0fa");
  sky.addColorStop(1, "#e3f1ff");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  // sun glow, upper right
  const sun = ctx.createRadialGradient(width * 0.8, height * 0.12, 0, width * 0.8, height * 0.12, height * 0.8);
  sun.addColorStop(0, "rgba(255,250,225,0.9)");
  sun.addColorStop(0.15, "rgba(255,244,210,0.45)");
  sun.addColorStop(1, "rgba(255,244,210,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, width, height);

  const r = rand(97);
  // thin high cirrus streaks
  ctx.save();
  for (let i = 0; i < 7; i++) {
    const x = r() * width;
    const y = height * (0.08 + r() * 0.3);
    const w = 120 + r() * 220;
    const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, `rgba(255,255,255,${0.35 + r() * 0.3})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, w / 2, 2.5 + r() * 3, -0.08, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // small fair-weather clouds higher up
  for (let i = 0; i < 4; i++) {
    const w = 70 + r() * 110;
    cumulus(ctx, r() * width, height * (0.25 + r() * 0.35), w, w * 0.18, r);
  }
  // towering cumulus standing on the horizon: back row paler (aerial perspective)
  // a few big ones with blue sky between them
  for (let x = -60 + r() * 120; x < width + 60; ) {
    const w = 200 + r() * 260;
    cumulus(ctx, x + w / 2, height * (0.95 + r() * 0.03), w, height * (0.18 + r() * 0.22), r);
    x += w * (0.9 + r() * 0.8);
  }
  // pale haze where the city meets the sky
  const haze = ctx.createLinearGradient(0, height * 0.86, 0, height);
  haze.addColorStop(0, "rgba(236,244,255,0)");
  haze.addColorStop(1, "rgba(236,244,255,1)");
  ctx.shadowBlur = 0;
  ctx.fillStyle = haze;
  ctx.fillRect(0, height * 0.86, width, height * 0.14);
}

/** The painted sky (repainted only when its size changes). The map moves it sideways on
 * rotation through `canvasRef` for a little parallax. */
export function PaintedSky({ className, canvasRef }: { className?: string; canvasRef?: { current: HTMLCanvasElement | null } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (canvasRef) canvasRef.current = el;
    let last = "";
    const repaint = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      const key = `${w}x${h}`;
      if (!w || !h || key === last) return;
      last = key;
      paintSky(el, w, h);
    };
    repaint();
    const ro = new ResizeObserver(repaint);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasRef]);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
