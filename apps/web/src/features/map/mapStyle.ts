/** Colour Manga: a north-up 2D illustrated city map.
 * Pastel land-use colours, coloured screentones, inked captions and flat building footprints.
 * Real coordinates and self-hosted Protomaps tiles remain unchanged.
 */
import dela from "@fontsource/dela-gothic-one/files/dela-gothic-one-latin-400-normal.woff2?url";
import delaExt from "@fontsource/dela-gothic-one/files/dela-gothic-one-latin-ext-400-normal.woff2?url";
import rounded700 from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-700-normal.woff2?url";
import rounded700ext from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-ext-700-normal.woff2?url";
import rounded800 from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-800-normal.woff2?url";
import rounded800ext from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-ext-800-normal.woff2?url";
import { type Flavor, layers, namedFlavor } from "@protomaps/basemaps";
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";

import { C, INK } from "../../theme/palette";
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
  background: C.land,
  earth: C.land,
  park_a: "#c5ebae",
  park_b: "#c5ebae",
  wood_a: "#a8dca4",
  wood_b: "#a8dca4",
  scrub_a: "#c5ebae",
  scrub_b: "#c5ebae",
  glacier: "#ffffff",
  sand: "#fbf1cf",
  beach: "#fbf1cf",
  hospital: "#ffe1e8",
  school: "#fff0b4",
  industrial: "#e5dafa",
  zoo: "#c5ebae",
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
    grassland: "#d6efbb",
    barren: "rgba(250, 247, 238, 1)",
    urban_area: "#fff0df",
    farmland: "#e5efc9",
    glacier: "rgba(255, 255, 255, 1)",
    scrub: "#cce7b5",
    forest: "#b7dfac",
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
    paint["line-color"] = ["step", ["zoom"], "#a3acc5", 12, "#fffdf7"];
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
        // cities: white lettering in black narration boxes; towns: plain ink lettering
        Object.assign(paint, {
          "text-color": ["step", ["get", "population_rank"], INK, 9, "#ffffff"],
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
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 14, 12.5, 17, 14],
          "text-padding": ["interpolate", ["linear"], ["zoom"], 11, 70, 14, 55, 16, 40],
          // district names are spoken: speech balloons
          "icon-image": "bubble",
          "icon-text-fit": "both",
          "icon-text-fit-padding": [3, 8, 9, 8],
          "text-offset": [0, -0.25],
        });
        Object.assign(paint, { "text-color": INK, "text-halo-width": 0, "text-opacity": ["interpolate", ["linear"], ["zoom"], 10.5, 0, 11.5, 1], "icon-opacity": ["interpolate", ["linear"], ["zoom"], 10.5, 0, 11.5, 1] });
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
        Object.assign(paint, { "text-color": INK, "text-halo-color": "#ffffff", "text-halo-width": 3 });
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
      id: "art-zoning-colour", type: "fill", source: "protomaps", "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", ["residential", "commercial", "retail", "industrial", "university", "college", "school"]]],
      paint: { "fill-color": ["match", ["get", "kind"], "residential", "#ffe6d1", ["commercial", "retail"], "#ffd9e7", "industrial", "#e4dcf8", "#fff0b4"] },
    },
    {
      // Coloured screentones add printed texture over pastel land-use fills.
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
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.2, 12, 0.45],
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
      paint: { "line-color": C.parkInk, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 15, 1.8] },
    },
  ],
  // Water: speed-line hatching only. Outline-based effects would also trace the tile seams of
  // the clipped water polygons, so the shore is defined by the contrast with the land tones.
  water: [
    {
      id: "art-water-texture",
      type: "fill",
      source: "protomaps",
      "source-layer": "water",
      filter: POLYGON,
      paint: { "fill-pattern": "tex-water" },
    },
  ],
};

/** Flat pastel building footprints with fine ink outlines and drawn shadows. */
const BUILDINGS: Layer[] = [
  {
    id: "art-building-shadow",
    type: "fill",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 13,
    paint: {
      // a drawn cast shadow (hatching), not a 3D model
      "fill-pattern": "hatch-shadow",
      "fill-translate": ["interpolate", ["linear"], ["zoom"], 13, ["literal", [1, 1.5]], 16, ["literal", [3, 4]]],
      "fill-translate-anchor": "viewport",
    },
  },
  {
    id: "art-building",
    type: "fill",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 13,
    paint: { "fill-color": ["match", ["%", ["to-number", ["coalesce", ["get", "height"], 0]], 3], 0, "#f2d4b5", 1, "#c4dfea", "#e3cdef"], "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 14, 1] },
  },
  {
    id: "art-building-edge",
    type: "line",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 13,
    paint: {
      // ink outlines at every scale where buildings show
      "line-color": "#817292",
      "line-width": ["interpolate", ["linear"], ["zoom"], 13.5, 0.5, 15, 1, 18, 1.8],
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
