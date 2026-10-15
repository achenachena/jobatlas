/** Procedural textures drawn on canvas: everything visual is original (spec §7.1). */
import * as THREE from "three";

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Three hard light steps (cel shading). */
export function toonGradient(): THREE.DataTexture {
  const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Sea: stylised wave strokes (diorama) or a screentone dot grid (manga panel). */
export function seaPattern(base: string, ink: string, kind: "waves" | "screentone"): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = ink;
  g.fillStyle = ink;
  if (kind === "screentone") {
    for (let y = 0; y < 256; y += 8)
      for (let x = (y / 8) % 2 ? 4 : 0; x < 256; x += 8) {
        g.beginPath();
        g.arc(x, y, 1.4, 0, Math.PI * 2);
        g.fill();
      }
  } else {
    g.lineWidth = 3;
    g.lineCap = "round";
    const waves: [number, number][] = [[30, 40], [150, 90], [80, 170], [200, 210], [20, 230], [190, 20]];
    for (const [x, y] of waves) {
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + 10, y - 9, x + 20, y);
      g.quadraticCurveTo(x + 30, y + 9, x + 40, y);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft round contact shadow. */
export function contactShadow(color: string): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, color);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.globalAlpha = 0.55;
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Diagonal ink hatching for the board's sides (manga shading). */
export function hatch(base: string, ink: string): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.fillStyle = base;
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = ink;
  g.globalAlpha = 0.18;
  g.lineWidth = 2;
  for (let i = -64; i < 128; i += 10) {
    g.beginPath();
    g.moveTo(i, 64);
    g.lineTo(i + 64, 0);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
