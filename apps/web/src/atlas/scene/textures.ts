/** Procedural textures drawn on canvas: everything visual is original. */
import * as THREE from "three";

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Soft contact shadow: solid under the foot (radius 0.4 of the quad = the base), fading
 * quickly outside it. */
export function contactShadow(color: string): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, color);
  grad.addColorStop(0.42, color);
  grad.addColorStop(0.6, "rgba(168,201,229,0.35)");
  grad.addColorStop(1, "rgba(168,201,229,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
