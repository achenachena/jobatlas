/** One glyph set for the whole product: drawn on a 24×24 grid, 2px strokes with round caps,
 * solid areas filled with the even-odd rule so windows/doors read as cut-outs.
 *
 * The same path data feeds the React <Icon> (SVG) and the canvas-drawn map markers
 * (Path2D), so a badge on the map and a chip in a panel always show the identical symbol. */

export interface Glyph {
  /** Solid shapes (even-odd). */
  fill?: string;
  /** Stroked lines (2px, round caps/joins at 24px). */
  stroke?: string;
}

export const GLYPHS = {
  /** Brand navigation star: four long points, the shape repeated in the logo, the
   * region-cluster emblem, the locate button and empty states. */
  star: { fill: "M12 1.8 14.1 9.9 22.2 12 14.1 14.1 12 22.2 9.9 14.1 1.8 12 9.9 9.9Z" },
  starSmall: { fill: "M12 5.5 13.4 10.6 18.5 12 13.4 13.4 12 18.5 10.6 13.4 5.5 12 10.6 10.6Z" },

  /** On-site: an office block with lit windows. */
  onSite: {
    fill:
      "M5 21V4.6C5 3.7 5.7 3 6.6 3h7.8c.9 0 1.6.7 1.6 1.6V9h2.4c.9 0 1.6.7 1.6 1.6V21Z" +
      "M8 6.2h2v2.3H8ZM11.2 6.2h2v2.3h-2ZM8 10.4h2v2.3H8ZM11.2 10.4h2v2.3h-2ZM8 14.6h2v2.3H8ZM11.2 14.6h2v2.3h-2Z" +
      "M16.3 12h1.7v2.2h-1.7ZM16.3 16h1.7v2.2h-1.7ZM9.4 21v-2.6h2.4V21Z",
  },
  /** Hybrid: a home and an office side by side. */
  hybrid: {
    fill:
      "M1.8 12.4 6.9 7.6l5.1 4.8V21H1.8Z M5.4 21v-3.8h3V21Z" +
      "M13.4 21V4.4c0-.8.6-1.4 1.4-1.4h5.4c.8 0 1.4.6 1.4 1.4V21Z" +
      "M15.4 6h1.7v2h-1.7ZM18 6h1.7v2H18ZM15.4 10h1.7v2h-1.7ZM18 10h1.7v2H18ZM15.4 14h1.7v2h-1.7ZM18 14h1.7v2H18Z",
  },
  /** Remote: a signal reaching out from a point. */
  remote: {
    stroke: "M3.6 9.8a12 12 0 0 1 16.8 0M6.7 13a7.6 7.6 0 0 1 10.6 0M9.7 16.2a3.3 3.3 0 0 1 4.6 0",
    fill: "M12 18.3a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z",
  },
  /** Workplace not stated. */
  unknown: {
    stroke: "M8.9 8.6a3.2 3.2 0 1 1 4.7 2.9c-1 .5-1.6 1.3-1.6 2.4v.8",
    fill: "M12 17.3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z",
  },
  /** Several jobs at one address. */
  stack: {
    stroke: "M7 6.5V5.2C7 4.5 7.5 4 8.2 4h10.6c.7 0 1.2.5 1.2 1.2v10.6c0 .7-.5 1.2-1.2 1.2H17.5",
    fill: "M4 9.2C4 8.5 4.5 8 5.2 8h9.6c.7 0 1.2.5 1.2 1.2v9.6c0 .7-.5 1.2-1.2 1.2H5.2C4.5 20 4 19.5 4 18.8Z",
  },
  filter: {
    stroke: "M4 7h9.5M18 7h2M4 17h2.5M11 17h9",
    fill: "M15.8 4.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8ZM8.8 14.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z",
  },
  locate: {
    stroke: "M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2M18.2 12a6.2 6.2 0 1 1-12.4 0 6.2 6.2 0 0 1 12.4 0Z",
    fill: "M12 8.6 12.9 11.1 15.4 12 12.9 12.9 12 15.4 11.1 12.9 8.6 12 11.1 11.1Z",
  },
  search: { stroke: "M16.6 16.6 21 21M18.4 10.7a7.7 7.7 0 1 1-15.4 0 7.7 7.7 0 0 1 15.4 0Z" },
  pin: {
    stroke: "M12 21.2s-6.8-6.1-6.8-11.4a6.8 6.8 0 0 1 13.6 0c0 5.3-6.8 11.4-6.8 11.4Z",
    fill: "M12 7.4a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z",
  },
  list: {
    stroke: "M9 6h11M9 12h11M9 18h11",
    fill: "M4.6 4.6h2.8v2.8H4.6ZM4.6 10.6h2.8v2.8H4.6ZM4.6 16.6h2.8v2.8H4.6Z",
  },
  clock: { stroke: "M12 7v5l3.2 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
  close: { stroke: "M6 6l12 12M18 6 6 18" },
  plus: { stroke: "M12 5v14M5 12h14" },
  minus: { stroke: "M5 12h14" },
  back: { stroke: "M14.5 5.5 8 12l6.5 6.5" },
  external: { stroke: "M13.5 4.5H19.5V10.5M19.5 4.5 11 13M17 14.5v4c0 .8-.7 1.5-1.5 1.5h-10C4.7 20 4 19.3 4 18.5v-10C4 7.7 4.7 7 5.5 7h4" },
  expand: { stroke: "M6 14.5 12 8.5l6 6" },
  collapse: { stroke: "M6 9.5 12 15.5l6-6" },
  route: { stroke: "M4 19c3-1 3.5-4.5 6.5-5s4 2 7-1.5S19 6 20 5" },
  tilt: { stroke: "M4 17 12 21l8-4M4 12l8 4 8-4M12 3 4 7l8 4 8-4Z" },

  // Landmark stickers (real POIs on the map)
  train: {
    fill:
      "M7.2 2.8h9.6c1.8 0 3.2 1.4 3.2 3.2v8.6c0 1.8-1.4 3.2-3.2 3.2H7.2C5.4 17.8 4 16.4 4 14.6V6c0-1.8 1.4-3.2 3.2-3.2Z" +
      "M6.6 6.2v4.4h10.8V6.2ZM8.2 12.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8ZM15.8 12.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z",
    stroke: "M8 18.5 6 21.5M16 18.5l2 3",
  },
  cap: { fill: "M12 3.5 1.5 8.8 12 14l10.5-5.2Z", stroke: "M6 11.2v4.4c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.4M21 9.4v5.4" },
  stadium: {
    stroke: "M3 12c0-3.3 4-6 9-6s9 2.7 9 6-4 6-9 6-9-2.7-9-6Z",
    fill: "M7.4 12c0-1.5 2.1-2.7 4.6-2.7s4.6 1.2 4.6 2.7-2.1 2.7-4.6 2.7-4.6-1.2-4.6-2.7Z",
  },
  museum: { fill: "M12 2.5 2.5 7.6h19ZM3.5 18.8h17v2.7h-17Z", stroke: "M6 10.2v6.4M10 10.2v6.4M14 10.2v6.4M18 10.2v6.4" },
  cross: { fill: "M9.6 3h4.8v6.6H21v4.8h-6.6V21H9.6v-6.6H3V9.6h6.6Z" },
  book: { stroke: "M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5c-3.5-.5-6.5 0-8.5 1.5ZM12 6.5v13" },
  anchor: {
    stroke: "M12 7.2v13.5M8 10.5h8M4.6 13.6c.5 4 3.5 7 7.4 7s6.9-3 7.4-7",
    fill: "M12 2.4a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6Z",
  },
  tree: {
    fill: "M12 2.2c3.7 0 6.6 2.8 6.6 6.3 0 1.2-.3 2.3-.9 3.2 1.1.9 1.8 2.2 1.8 3.6 0 2.7-2.4 4.7-5.3 4.7H9.8c-2.9 0-5.3-2-5.3-4.7 0-1.4.7-2.7 1.8-3.6-.6-.9-.9-2-.9-3.2 0-3.5 2.9-6.3 6.6-6.3Z",
  },
} satisfies Record<string, Glyph>;

export type GlyphName = keyof typeof GLYPHS;
