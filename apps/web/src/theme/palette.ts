/** "Manga Panel" palette (docs/visual-redesign.md). One source for the map art, the
 * canvas-drawn markers/icons and (mirrored in tokens.css) the UI.
 *
 * Printed like a two-colour manga: black ink on white paper, grey only as screentone, and ONE
 * spot colour — vermilion — for everything that matters (jobs, the selection, motorways). */

export const INK = "#17151f"; // line art, lettering
export const PAPER = "#fdfbf5";

export const C = {
  ink: INK,
  ink2: "#3b3848",
  tone: "#8d8a99", // screentone dots / hatching
  toneLight: "#c9c6d3",
  paper: PAPER,
  paperShade: "#f1ede2",
  red: "#e63b2e", // the one spot colour
  redSoft: "#ffd9d3",
  // legacy names, all mapped into the two-colour print
  sky: "#e63b2e",
  skyDeep: "#17151f",
  sakura: "#e63b2e",
  sun: "#e63b2e",
  mint: "#17151f",
  lilac: "#17151f",
  water: "#ffffff",
  waterDeep: "#17151f",
  park: "#ffffff",
  parkInk: "#17151f",
} as const;

export type MarkerKind = "on_site" | "hybrid" | "remote" | "unknown";

/** Per workplace type: spot colour + glyph colour. Shading is drawn as screentone dots. */
export const KIND_COLORS: Record<MarkerKind, { base: string; tint: string; glyph: string }> = {
  on_site: { base: C.red, tint: "#ffffff", glyph: "#ffffff" },
  hybrid: { base: C.red, tint: "#ffffff", glyph: "#ffffff" },
  remote: { base: C.red, tint: "#ffffff", glyph: C.red },
  unknown: { base: "#ffffff", tint: "#ffffff", glyph: INK },
};
