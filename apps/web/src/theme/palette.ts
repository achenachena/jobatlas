/** "Twilight City" palette (docs/visual-redesign.md): an anime-film city at dusk. One source
 * for the map art, the canvas-drawn markers/icons and (mirrored in tokens.css) the UI.
 *
 * Strictly limited hues: indigo / violet for the city in shadow, peach-amber for sunset light
 * and street lights, cyan for water and interactive accents, a little sakura for focus. */

export const INK = "#0d1030"; // deepest navy: outlines, text on light chips
export const PAPER = "#f6f1ff"; // pale lavender-white: text on dark, highlights

export const C = {
  ink: INK,
  night: "#141838", // ground
  dusk: "#1d2250", // blocks / panels
  violet: "#3a3a8c",
  lavender: "#a9a2ff",
  peach: "#ffb08a", // sunset light
  amber: "#ffcf73", // street lights, highlights
  sakura: "#ff7eb3",
  cyan: "#5fe0ff",
  sky: "#5aa9ff",
  mint: "#5fe3b5",
  water: "#0c2350",
  waterLight: "#1e4f8f",
  park: "#18334a",
  parkLight: "#2a5a63",
  paper: PAPER,
} as const;

export type MarkerKind = "on_site" | "hybrid" | "remote" | "unknown";

/** Per workplace type: badge colour + glyph colour (badges glow on the dark city). */
export const KIND_COLORS: Record<MarkerKind, { base: string; tint: string; glyph: string }> = {
  on_site: { base: C.amber, tint: "#fff1cc", glyph: INK },
  hybrid: { base: C.mint, tint: "#d9fff1", glyph: INK },
  remote: { base: C.sakura, tint: INK, glyph: C.sakura },
  unknown: { base: PAPER, tint: INK, glyph: PAPER },
};
