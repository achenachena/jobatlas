/** "Painted Summer Town" palette (docs/visual-redesign.md): an anime-film background — a
 * Ghibli / Shinkai-style city on a summer afternoon. One source for the map art, the
 * canvas-painted markers/textures/sky and (mirrored in tokens.css) the UI.
 *
 * Painted, not rendered: warm sunlit surfaces, cool blue-violet shadows (never grey or black),
 * saturated greens, bright turquoise water, a deep summer-blue sky with white cumulus. */

export const INK = "#2d3550"; // darkest paint: text, fine lines (a deep blue, never black)
export const PAPER = "#fffaf0";

export const C = {
  ink: INK,
  ink2: "#4b5578",
  paper: PAPER,
  // light and shadow
  sunlit: "#fff4dc",
  shade: "#a9b4dd", // cool shadow
  shadeDeep: "#7f8bc4",
  // land
  land: "#f3ecd6",
  landWarm: "#efe2c2",
  road: "#fffdf6",
  roadEdge: "#d9cdb0",
  // nature
  grass: "#9fd67c",
  grassDeep: "#5fae5a",
  forest: "#4f9e57",
  water: "#4cc3e6",
  waterDeep: "#2a96cf",
  waterLight: "#b8f0ff",
  // spot colours
  sky: "#4aa8f0",
  skyDeep: "#2b7fd9",
  sun: "#ffc84a",
  sakura: "#ff8fb1",
  terracotta: "#e9876a",
  teal: "#3fb7a3",
} as const;

export type MarkerKind = "on_site" | "hybrid" | "remote" | "unknown";

/** Per workplace type: badge colour, its painted shade, and the glyph colour. */
export const KIND_COLORS: Record<MarkerKind, { base: string; shade: string; glyph: string }> = {
  on_site: { base: "#3d8fe0", shade: "#2a6bb8", glyph: "#ffffff" },
  hybrid: { base: "#3fb38c", shade: "#2b8a6b", glyph: "#ffffff" },
  remote: { base: "#ff8fb1", shade: "#e2668f", glyph: "#ff6f9e" },
  unknown: { base: "#fffaf0", shade: "#c9c2b0", glyph: "#5b6380" },
};
