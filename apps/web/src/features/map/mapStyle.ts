/** "Colour Manga Page" basemap (docs/visual-redesign.md).
 *
 * Tiles: a GTA extract of the Protomaps OpenStreetMap build served as one PMTiles file
 * (VITE_MAP_TILES_URL). Labels use bundled web fonts through the style's `font-faces` (drawn
 * client-side): Dela Gothic One for display lettering (city captions, counts), M PLUS Rounded
 * 1c for everything else. `glyphs` (self-hosted Noto Sans) is only a fallback outside Latin.
 * No third-party servers. Data © OpenStreetMap contributors (ODbL).
 *
 * Every road, shoreline, building and POI stays where OSM puts it. The manga look is in how
 * it is drawn:
 *  - paper and ink: off-white paper with grain, near-black line art, few spot colours;
 *  - screentones instead of flat fills: grey dots (residential), sakura dots (commercial),
 *    hatching (industrial), sun dots (campus);
 *  - water as a spot colour with ink wave curls, a halftone band along the shore, a white
 *    foam line and an ink shoreline; parks as pale mint with inked bushes and an ink edge;
 *  - roads as white strips with ink edges (only thin grey lines at city scale), motorways
 *    with a sun-yellow spot colour; buildings as white blocks, ink outline, hatched shadow;
 *  - city names in narration boxes; landmarks and real street trees as small inked stickers.
 */
import dela from "@fontsource/dela-gothic-one/files/dela-gothic-one-latin-400-normal.woff2?url";
import delaExt from "@fontsource/dela-gothic-one/files/dela-gothic-one-latin-ext-400-normal.woff2?url";
import rounded700 from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-700-normal.woff2?url";
import rounded700ext from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-ext-700-normal.woff2?url";
import rounded800 from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-800-normal.woff2?url";
import rounded800ext from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-ext-800-normal.woff2?url";
import { type Flavor, layers, namedFlavor } from "@protomaps/basemaps";
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";

import { C, INK, PAPER } from "../../theme/palette";
import { LANDMARKS } from "./markerImages";

export const TILES_URL: string =
  (import.meta.env.VITE_MAP_TILES_URL as string | undefined) ?? "/tiles/gta.pmtiles";
export const GLYPHS_URL: string =
  (import.meta.env.VITE_MAP_GLYPHS_URL as string | undefined) ??
  `${location.origin}/tiles/fonts/{fontstack}/{range}.pbf`;

const abs = (u: string) => new URL(u, location.origin).toString();
const LATIN = ["U+0000-00FF", "U+0131", "U+0152-0153", "U+02BB-02BC", "U+02C6", "U+02DA", "U+02DC", "U+2000-206F", "U+20AC", "U+2122", "U+2212"];
const LATIN_EXT = ["U+0100-02AF", "U+1E00-1EFF", "U+2020", "U+20A0-20AB", "U+20AD-20CF", "U+2C60-2C7F", "U+A720-A7FF"];
export const FONT_BOLD = "JobAtlas Rounded Bold";
export const FONT_HEAVY = "JobAtlas Rounded Heavy";
export const FONT_DISPLAY = "JobAtlas Display";
const face = (latin: string, ext: string) => [
  { url: abs(latin), "unicode-range": LATIN },
  { url: abs(ext), "unicode-range": LATIN_EXT },
];
const FONT_FACES = {
  [FONT_BOLD]: face(rounded700, rounded700ext),
  [FONT_HEAVY]: face(rounded800, rounded800ext),
  [FONT_DISPLAY]: face(dela, delaExt),
};

const flavor: Flavor = {
  ...namedFlavor("light"),
  background: "#efe9db",
  earth: PAPER,
  park_a: C.park,
  park_b: C.park,
  wood_a: "#a9e8b8",
  wood_b: "#a9e8b8",
  scrub_a: "#d4f3d6",
  scrub_b: "#d4f3d6",
  glacier: "#ffffff",
  sand: "#fbf1cf",
  beach: "#fbf1cf",
  hospital: PAPER,
  school: PAPER,
  industrial: PAPER,
  zoo: C.park,
  aerodrome: "#f3f0e7",
  runway: "#ffffff",
  pedestrian: "#ffffff",
  pier: "#ffffff",
  military: "#f3f0e7",
  water: C.water,
  buildings: "#ffffff",
  other: "#ffffff",
  minor_service: "#ffffff",
  minor_a: "#ffffff",
  minor_b: "#ffffff",
  link: "#ffffff",
  major: "#ffffff",
  highway: C.sun,
  minor_service_casing: INK,
  minor_casing: INK,
  link_casing: INK,
  major_casing_early: INK,
  major_casing_late: INK,
  highway_casing_early: INK,
  highway_casing_late: INK,
  bridges_other_casing: INK,
  bridges_minor_casing: INK,
  bridges_link_casing: INK,
  bridges_major_casing: INK,
  bridges_highway_casing: INK,
  bridges_other: "#ffffff",
  bridges_minor: "#ffffff",
  bridges_link: "#ffffff",
  bridges_major: "#ffffff",
  bridges_highway: C.sun,
  tunnel_other_casing: C.toneLight,
  tunnel_minor_casing: C.toneLight,
  tunnel_link_casing: C.toneLight,
  tunnel_major_casing: C.toneLight,
  tunnel_highway_casing: C.tone,
  tunnel_other: "#ffffff",
  tunnel_minor: "#ffffff",
  tunnel_link: "#ffffff",
  tunnel_major: "#ffffff",
  tunnel_highway: "#fff3c4",
  railway: INK,
  boundaries: C.tone,
  landcover: {
    grassland: "rgba(222, 246, 222, 1)",
    barren: "rgba(250, 247, 238, 1)",
    urban_area: "rgba(253, 251, 245, 1)",
    farmland: "rgba(246, 244, 228, 1)",
    glacier: "rgba(255, 255, 255, 1)",
    scrub: "rgba(222, 246, 222, 1)",
    forest: "rgba(196, 238, 204, 1)",
  },
};

type Layer = LayerSpecification;
type Exp = ExpressionSpecification;
const POLYGON: Exp = ["==", ["geometry-type"], "Polygon"];
const NAME: Exp = ["coalesce", ["get", "name:en"], ["get", "name"]];
const PARKISH = ["park", "national_park", "nature_reserve", "golf_course", "forest", "wood", "garden", "recreation_ground", "cemetery"];

/** Road widths. Below z12 arterials are thin grey strokes (no casing) so the city view is not
 * a mesh of lines; from z12 they become white strips with ink edges. */
const W = {
  major: ["interpolate", ["exponential", 1.6], ["zoom"], 8, 0.3, 11, 0.8, 12, 2.6, 15, 7, 18, 22] as Exp,
  highway: ["interpolate", ["exponential", 1.6], ["zoom"], 5, 0.6, 9, 1.8, 12, 3.6, 15, 9, 18, 26] as Exp,
  casing: ["interpolate", ["linear"], ["zoom"], 12, 1, 15, 2.2, 18, 3] as Exp,
};

function tune(layer: Layer): Layer | null {
  const l = structuredClone(layer) as Layer & { layout?: Record<string, unknown>; paint?: Record<string, unknown>; minzoom?: number };
  const id = l.id;
  const paint = (l.paint ??= {}) as Record<string, unknown>;
  const layout = (l.layout ??= {}) as Record<string, unknown>;

  // Generalisation: side streets, service roads and paths only at street level.
  if (/^roads_(minor|minor_service|other|link)(_casing)?$/.test(id) || /^roads_bridges_(minor|other|link)/.test(id)) {
    l.minzoom = Math.max(l.minzoom ?? 0, id.includes("other") ? 15.5 : 13.5);
  }
  if (/^roads_tunnels_(minor|other|link)/.test(id)) l.minzoom = 15;

  if (/^roads(_bridges|_tunnels)?_major$/.test(id)) {
    paint["line-width"] = W.major;
    paint["line-color"] = ["step", ["zoom"], C.tone, 12, "#ffffff"];
  }
  if (/^roads(_bridges|_tunnels)?_major_casing/.test(id)) {
    l.minzoom = Math.max(l.minzoom ?? 0, 12);
    paint["line-gap-width"] = W.major;
    paint["line-width"] = W.casing;
  }
  if (/^roads(_bridges|_tunnels)?_highway$/.test(id)) paint["line-width"] = W.highway;
  if (/^roads(_bridges|_tunnels)?_highway_casing/.test(id)) {
    paint["line-gap-width"] = W.highway;
    paint["line-width"] = ["interpolate", ["linear"], ["zoom"], 6, 0.8, 12, 1.8, 15, 2.8];
  }
  if (/^roads_(minor|minor_service)_casing$/.test(id)) {
    paint["line-color"] = ["step", ["zoom"], C.tone, 15, INK];
    paint["line-width"] = ["interpolate", ["linear"], ["zoom"], 13.5, 0.5, 16, 1.4];
  }
  if (id === "roads_rail") {
    paint["line-color"] = C.tone;
    paint["line-opacity"] = 1;
    paint["line-dasharray"] = [3, 2];
    paint["line-width"] = ["interpolate", ["linear"], ["zoom"], 10, 0.8, 16, 1.8];
  }
  if (id === "landuse_park") paint["fill-opacity"] = ["interpolate", ["linear"], ["zoom"], 6, 0.5, 10, 1];

  if (l.type === "symbol") {
    const ink = { "text-color": INK, "text-halo-color": "#ffffff", "text-halo-width": 2.6, "text-halo-blur": 0 };
    switch (id) {
      case "places_locality":
        // Larger cities sit in narration boxes; small towns are plain lettering.
        for (const k of ["icon-size", "icon-padding", "text-radial-offset", "text-variable-anchor", "text-justify"]) delete layout[k];
        Object.assign(layout, {
          "text-field": NAME,
          "text-font": ["step", ["get", "population_rank"], ["literal", [FONT_HEAVY]], 9, ["literal", [FONT_DISPLAY]]],
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, ["step", ["get", "population_rank"], 10, 9, 14], 12, ["step", ["get", "population_rank"], 12, 9, 19]],
          "icon-image": ["step", ["get", "population_rank"], "", 9, "banner"],
          "icon-text-fit": "both",
          "icon-text-fit-padding": [4, 9, 5, 9],
          "text-padding": 14,
        });
        Object.assign(paint, {
          "text-color": INK,
          "text-halo-color": "#ffffff",
          "text-halo-width": ["step", ["get", "population_rank"], 2.4, 9, 0],
        });
        return l;
      case "places_subplace":
        Object.assign(layout, {
          "text-field": NAME,
          "text-font": [FONT_HEAVY],
          "text-transform": "none",
          "text-letter-spacing": 0.02,
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 14, 13.5, 17, 16],
          "text-padding": ["interpolate", ["linear"], ["zoom"], 11, 30, 14, 22],
        });
        Object.assign(paint, { ...ink, "text-color": C.ink2, "text-opacity": ["interpolate", ["linear"], ["zoom"], 10.5, 0, 11.5, 1] });
        return l;
      case "roads_labels_major":
      case "roads_labels_minor":
        Object.assign(layout, { "text-field": NAME, "text-font": [FONT_BOLD], "text-size": ["interpolate", ["linear"], ["zoom"], 12, 11, 16, 13.5] });
        Object.assign(paint, ink);
        return l;
      case "water_label_lakes":
      case "water_label_ocean":
      case "water_waterway_label":
        Object.assign(layout, { "text-field": NAME, "text-font": [FONT_DISPLAY], "text-letter-spacing": 0.1 });
        Object.assign(paint, { "text-color": C.skyDeep, "text-halo-color": "#ffffff", "text-halo-width": 2.4 });
        return l;
      case "places_region":
      case "places_country":
      case "earth_label_islands":
        Object.assign(layout, { "text-field": NAME, "text-font": [FONT_BOLD] });
        Object.assign(paint, { ...ink, "text-color": C.tone });
        return l;
      case "address_label":
        layout["text-font"] = [FONT_BOLD];
        Object.assign(paint, { "text-color": C.tone });
        return l;
      default:
        return null; // remaining symbol layers need the Protomaps sprite sheet
    }
  }
  return l;
}

/** Extra art layers inserted right after a basemap layer id. */
const EXTRAS: Record<string, Layer[]> = {
  earth: [
    {
      id: "art-paper",
      type: "fill",
      source: "protomaps",
      "source-layer": "earth",
      paint: { "fill-pattern": "paper" },
    },
  ],
  landcover: [
    {
      // Zoning as screentones: the city reads as a drawn page, not coloured blocks.
      id: "art-zoning-tone",
      type: "fill",
      source: "protomaps",
      "source-layer": "landuse",
      minzoom: 10,
      filter: ["in", ["get", "kind"], ["literal", ["residential", "commercial", "retail", "industrial", "university", "college", "school"]]],
      paint: {
        "fill-pattern": ["match", ["get", "kind"],
          "residential", "tone-light",
          ["commercial", "retail"], "tone-pink",
          "industrial", "tone-lines",
          "tone-sun"],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 12, 1],
      },
    },
  ],
  landuse_park: [
    {
      id: "art-park-trees",
      type: "fill",
      source: "protomaps",
      "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", PARKISH]],
      minzoom: 11.5,
      paint: { "fill-pattern": "tex-trees", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, 0.4, 13, 1] },
    },
    {
      id: "art-park-edge",
      type: "line",
      source: "protomaps",
      "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", PARKISH]],
      minzoom: 11,
      paint: { "line-color": INK, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 15, 1.8] },
    },
  ],
  water: [
    {
      // Halftone band hugging the shore on the water side.
      id: "art-water-tone",
      type: "line",
      source: "protomaps",
      "source-layer": "water",
      filter: POLYGON,
      minzoom: 9,
      paint: {
        "line-pattern": "tone-band",
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 4, 12, 12, 16, 22],
        "line-offset": ["interpolate", ["linear"], ["zoom"], 9, 3, 12, 8, 16, 13],
      },
    },
    {
      id: "art-water-texture",
      type: "fill",
      source: "protomaps",
      "source-layer": "water",
      filter: POLYGON,
      paint: { "fill-pattern": "tex-water" },
    },
    {
      id: "art-water-foam",
      type: "line",
      source: "protomaps",
      "source-layer": "water",
      filter: POLYGON,
      minzoom: 10,
      paint: {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 16, 3],
        "line-offset": ["interpolate", ["linear"], ["zoom"], 10, 2.4, 16, 4],
      },
    },
    {
      id: "art-water-ink",
      type: "line",
      source: "protomaps",
      "source-layer": "water",
      filter: POLYGON,
      minzoom: 7,
      paint: { "line-color": INK, "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.8, 12, 2, 16, 3] },
    },
  ],
};

/** Buildings: white blocks, ink outline, hatched shadow (offset down-right). */
const BUILDINGS: Layer[] = [
  {
    id: "art-building-shadow",
    type: "fill",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 15,
    paint: {
      "fill-pattern": "hatch-shadow",
      "fill-translate": [2.5, 3],
      "fill-translate-anchor": "viewport",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 15.6, 1],
    },
  },
  {
    id: "art-building",
    type: "fill",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 13,
    paint: { "fill-color": "#ffffff", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 14, 1] },
  },
  {
    id: "art-building-edge",
    type: "line",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 13.5,
    paint: {
      // light grey at district scale (keeps the page airy), full ink at street level
      "line-color": ["step", ["zoom"], C.toneLight, 15, INK],
      "line-width": ["interpolate", ["linear"], ["zoom"], 13.5, 0.4, 15, 0.8, 18, 1.6],
    },
  },
];

/** Above the line work: real street trees and landmark stickers (low density). */
const ON_TOP: Layer[] = [
  {
    id: "art-street-trees",
    type: "symbol",
    source: "protomaps",
    "source-layer": "pois",
    minzoom: 16,
    filter: ["==", ["get", "kind"], "tree"],
    layout: { "icon-image": "street-tree", "icon-anchor": "bottom", "icon-padding": 1, "icon-size": ["interpolate", ["linear"], ["zoom"], 16, 0.8, 18, 1.3] },
  },
  {
    id: "art-landmarks",
    type: "symbol",
    source: "protomaps",
    "source-layer": "pois",
    minzoom: 12,
    filter: ["all",
      ["in", ["get", "kind"], ["literal", Object.keys(LANDMARKS)]],
      [">=", ["zoom"], ["+", ["get", "min_zoom"], 0.5]]],
    layout: {
      "symbol-sort-key": ["get", "min_zoom"],
      "icon-image": ["concat", "lm-", ["get", "kind"]],
      "icon-padding": 10,
      "text-field": ["step", ["zoom"], "", 14, NAME],
      "text-font": [FONT_HEAVY],
      "text-size": 11.5,
      "text-anchor": "top",
      "text-offset": [0, 1.25],
      "text-max-width": 8,
      "text-optional": true,
    },
    paint: { "text-color": INK, "text-halo-color": "#ffffff", "text-halo-width": 2.4 },
  },
];

/** Sky for the tilted camera (seen only at steep pitch): bright blue over a paper horizon. */
const SKY = {
  "sky-color": "#38b6ff",
  "horizon-color": PAPER,
  "sky-horizon-blend": 0.7,
  "horizon-fog-blend": 0.6,
  "fog-color": "#e6f6ff",
  "fog-ground-blend": 0.5,
  "atmosphere-blend": 0,
};

export function buildStyle(): StyleSpecification {
  const out: Layer[] = [];
  for (const layer of layers("protomaps", flavor, { lang: "en" }) as Layer[]) {
    if (layer.id === "buildings") {
      out.push(...BUILDINGS);
      continue;
    }
    const tuned = tune(layer);
    if (tuned) out.push(tuned);
    out.push(...(EXTRAS[layer.id] ?? []));
  }
  // Stickers go below the place labels so city captions win collisions.
  const firstLabel = out.findIndex((l) => l.id === "places_subplace");
  out.splice(firstLabel < 0 ? out.length : firstLabel, 0, ...ON_TOP);
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    "font-faces": FONT_FACES,
    sky: SKY,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${TILES_URL}`,
        attribution:
          '<a href="https://openstreetmap.org/copyright">© OpenStreetMap contributors</a> · <a href="https://protomaps.com">Protomaps</a>',
      },
    },
    layers: out,
  } as unknown as StyleSpecification;
}
