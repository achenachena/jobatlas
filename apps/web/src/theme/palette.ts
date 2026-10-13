/** "Colour Manga Map" palette (docs/visual-redesign.md). One source for the map art, the
 * canvas-drawn markers/icons and (mirrored in tokens.css) the UI.
 *
 * A full-colour manga / anime illustration: near-black ink line art over bright, clean anime
 * colours, with shading done as COLOURED screentone and hatching instead of grey. */

export const INK = "#17151f"; // line art, lettering
export const PAPER = "#fdfbf5";

export const C = {
  ink: INK,
  ink2: "#3b3848",
  tone: "#8d8a99", // screentone dots / hatching
  toneLight: "#c9c6d3",
  paper: PAPER,
  paperShade: "#f1ede2",
  sky: "#38b6ff",
  skyDeep: "#1769e0",
  sakura: "#ff5c93",
  sun: "#ffd43b",
  mint: "#3ddc97",
  lilac: "#9a7bff",
  red: "#ff4d6d",
  // map
  land: "#fff7e8",
  water: "#5fd0ff",
  waterDeep: "#1f8fe0",
  park: "#8fe08a",
  parkInk: "#1f7a4a",
} as const;

export type MarkerKind = "on_site" | "hybrid" | "remote" | "unknown";

/** Per workplace type: spot colour + glyph colour. Shading is drawn as screentone dots. */
export const KIND_COLORS: Record<MarkerKind, { base: string; tint: string; glyph: string }> = {
  on_site: { base: C.skyDeep, tint: "#d6e8ff", glyph: "#ffffff" },
  hybrid: { base: "#16b07a", tint: "#d9f7e9", glyph: "#ffffff" },
  remote: { base: C.sakura, tint: "#ffffff", glyph: C.sakura },
  unknown: { base: "#ffffff", tint: "#ffffff", glyph: INK },
};
