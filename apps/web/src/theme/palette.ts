/** "Summer Anime City" palette (docs/visual-redesign.md). One source for the map art, the
 * canvas-drawn markers/icons and (mirrored in tokens.css) the UI. */

export const INK = "#2b3566"; // line-art ink: outlines, text
export const PAPER = "#fffaf0";

export const C = {
  ink: INK,
  ink2: "#4a5285",
  paper: PAPER,
  sky: "#36a9ff",
  skyDeep: "#1a73e8",
  sakura: "#ff6f9c",
  sun: "#ffd23f",
  mint: "#2ec99a",
  lilac: "#9b7bff",
  // map
  land: "#fdf3dc",
  residential: "#fde6cc",
  commercial: "#ffdde8",
  industrial: "#e7e3f7",
  school: "#fff0ad",
  hospital: "#ffe0e0",
  park: "#93dd73",
  parkDeep: "#5fc163",
  wood: "#6fcf6f",
  water: "#45c1f2",
  shallows: "#93e2fb",
  shore: "#2a6fae",
} as const;

export type MarkerKind = "on_site" | "hybrid" | "remote" | "unknown";

/** Two-tone cel colours per workplace type: base + shade (lower-right) + glyph. */
export const KIND_COLORS: Record<MarkerKind, { base: string; shade: string; tint: string; glyph: string }> = {
  on_site: { base: "#2f8cff", shade: "#1f66d1", tint: "#d8ebff", glyph: "#ffffff" },
  hybrid: { base: "#22c08e", shade: "#14966d", tint: "#dcf7ec", glyph: "#ffffff" },
  remote: { base: "#8b6cff", shade: "#6a4ae0", tint: "#ffffff", glyph: "#7a5af5" },
  unknown: { base: "#8c90ad", shade: "#6f7392", tint: "#fffaf0", glyph: INK },
};
