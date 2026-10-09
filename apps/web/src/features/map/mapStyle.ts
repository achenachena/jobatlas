/** "Summer Anime City" basemap (docs/visual-redesign.md).
 *
 * Tiles: a GTA extract of the Protomaps OpenStreetMap build served as one PMTiles file
 * (VITE_MAP_TILES_URL). Labels use the bundled M PLUS Rounded 1c web font through the style's
 * `font-faces` (drawn client-side); `glyphs` (self-hosted Noto Sans) is only a fallback for
 * characters outside Latin. No third-party servers. Data © OpenStreetMap contributors (ODbL).
 *
 * Every road, shoreline, building and POI stays where OSM puts it. The anime look comes from:
 *  - generalisation: side streets and footpaths appear only at street level;
 *  - a high-key palette with colour zoning (residential / commercial / industrial / campus);
 *  - line art: ink shore lines, outlined parks, bold outlined arterials and highways;
 *  - illustration: tree texture in parks, wave + sparkle texture and a shallows band on water,
 *    real street trees and landmark stickers, city names on plates;
 *  - toon 3D buildings (real heights) under an anime sky when the camera is tilted.
 */
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
const FONT_FACES = {
  [FONT_BOLD]: [
    { url: abs(rounded700), "unicode-range": LATIN },
    { url: abs(rounded700ext), "unicode-range": LATIN_EXT },
  ],
  [FONT_HEAVY]: [
    { url: abs(rounded800), "unicode-range": LATIN },
    { url: abs(rounded800ext), "unicode-range": LATIN_EXT },
  ],
};

const flavor: Flavor = {
  ...namedFlavor("light"),
  background: "#f6e9cc",
  earth: C.land,
  park_a: C.park,
  park_b: C.park,
  wood_a: C.wood,
  wood_b: C.wood,
  scrub_a: "#b6e690",
  scrub_b: "#b6e690",
  glacier: "#ffffff",
  sand: "#ffe6a6",
  beach: "#ffe39a",
  hospital: C.hospital,
  school: C.school,
  industrial: C.industrial,
  zoo: C.park,
  aerodrome: "#ece8f5",
  runway: "#ffffff",
  pedestrian: "#fff3df",
  pier: "#f2e2c6",
  military: "#ece3d0",
  water: C.water,
  buildings: "#f0dfc4",
  other: "#ffffff",
  minor_service: "#ffffff",
  minor_a: "#ffffff",
  minor_b: "#ffffff",
  link: "#ffffff",
  major: "#ffffff",
  highway: "#fff4c2",
  minor_service_casing: "#e9cfae",
  minor_casing: "#e2c6a2",
  link_casing: "#9aa3cc",
  major_casing_early: "#9aa3cc",
  major_casing_late: "#8790c0",
  highway_casing_early: "#ff7fa3",
  highway_casing_late: "#ff7fa3",
  bridges_other_casing: "#9aa3cc",
  bridges_minor_casing: "#9aa3cc",
  bridges_link_casing: "#8790c0",
  bridges_major_casing: "#8790c0",
  bridges_highway_casing: "#ff7fa3",
  bridges_other: "#ffffff",
  bridges_minor: "#ffffff",
  bridges_link: "#ffffff",
  bridges_major: "#ffffff",
  bridges_highway: "#fff4c2",
  tunnel_other_casing: "#efe0c6",
  tunnel_minor_casing: "#efe0c6",
  tunnel_link_casing: "#efe0c6",
  tunnel_major_casing: "#efe0c6",
  tunnel_highway_casing: "#ffc4d4",
  tunnel_other: "#fbf2e2",
  tunnel_minor: "#fbf2e2",
  tunnel_link: "#fbf2e2",
  tunnel_major: "#fbf2e2",
  tunnel_highway: "#fff7dc",
  railway: INK,
  boundaries: "#c9a978",
  landcover: {
    grassland: "rgba(190, 233, 150, 1)",
    barren: "rgba(250, 233, 196, 1)",
    urban_area: "rgba(253, 236, 214, 1)",
    farmland: "rgba(214, 238, 160, 1)",
    glacier: "rgba(255, 255, 255, 1)",
    scrub: "rgba(196, 234, 156, 1)",
    forest: "rgba(120, 206, 120, 1)",
  },
};

type Layer = LayerSpecification;
type Exp = ExpressionSpecification;
const POLYGON: Exp = ["==", ["geometry-type"], "Polygon"];
const NAME: Exp = ["coalesce", ["get", "name:en"], ["get", "name"]];
const PARKISH = ["park", "national_park", "nature_reserve", "golf_course", "forest", "wood", "garden", "recreation_ground", "cemetery"];

/** Road widths, a little heavier than a reference map so the arterials read as drawn strokes. */
const W = {
  major: ["interpolate", ["exponential", 1.6], ["zoom"], 7, 0.4, 10, 1.2, 12, 2.6, 15, 7, 18, 22] as Exp,
  highway: ["interpolate", ["exponential", 1.6], ["zoom"], 5, 0.6, 9, 2, 12, 3.8, 15, 9, 18, 26] as Exp,
  casing: ["interpolate", ["linear"], ["zoom"], 8, 0.6, 12, 1.6, 15, 2.4] as Exp,
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

  if (/^roads(_bridges|_tunnels)?_major$/.test(id)) paint["line-width"] = W.major;
  if (/^roads(_bridges|_tunnels)?_major_casing/.test(id)) {
    paint["line-gap-width"] = W.major;
    paint["line-width"] = W.casing;
  }
  if (/^roads(_bridges|_tunnels)?_highway$/.test(id)) paint["line-width"] = W.highway;
  if (/^roads(_bridges|_tunnels)?_highway_casing/.test(id)) {
    paint["line-gap-width"] = W.highway;
    paint["line-width"] = ["interpolate", ["linear"], ["zoom"], 6, 0.8, 12, 2.2, 15, 3];
  }
  if (id === "roads_rail") {
    paint["line-opacity"] = 0.45;
    paint["line-dasharray"] = [2, 2];
  }
  if (id === "landuse_park") paint["fill-opacity"] = ["interpolate", ["linear"], ["zoom"], 6, 0.4, 10, 1];

  if (l.type === "symbol") {
    const ink = { "text-color": INK, "text-halo-color": "#ffffff", "text-halo-width": 2.4, "text-halo-blur": 0 };
    switch (id) {
      case "places_locality":
        // City names sit on plates (the banner is stretched around the text).
        for (const k of ["icon-size", "icon-padding", "text-radial-offset", "text-variable-anchor", "text-justify"]) delete layout[k];
        Object.assign(layout, {
          "text-field": NAME,
          "text-font": [FONT_HEAVY],
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, ["step", ["get", "population_rank"], 10, 9, 14], 12, ["step", ["get", "population_rank"], 12, 9, 18]],
          // Plates for the larger cities only; small towns are plain, quieter text.
          "icon-image": ["step", ["get", "population_rank"], "", 9, "banner"],
          "icon-text-fit": "both",
          "icon-text-fit-padding": [3, 9, 6, 9],
          "text-padding": 14,
        });
        Object.assign(paint, {
          "text-color": ["step", ["get", "population_rank"], C.ink2, 9, INK],
          "text-halo-color": "#ffffff",
          "text-halo-width": ["step", ["get", "population_rank"], 2.2, 9, 0],
        });
        return l;
      case "places_subplace":
        Object.assign(layout, {
          "text-field": NAME,
          "text-font": [FONT_BOLD],
          "text-transform": "none",
          "text-letter-spacing": 0.02,
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 14, 13.5, 17, 16],
          "text-padding": ["interpolate", ["linear"], ["zoom"], 11, 30, 14, 22],
        });
        Object.assign(paint, { ...ink, "text-color": "#6b5fb0", "text-halo-color": "#fffaf0", "text-opacity": ["interpolate", ["linear"], ["zoom"], 10.5, 0, 11.5, 1] });
        return l;
      case "roads_labels_major":
      case "roads_labels_minor":
        Object.assign(layout, { "text-field": NAME, "text-font": [FONT_BOLD], "text-size": ["interpolate", ["linear"], ["zoom"], 12, 11, 16, 13.5] });
        Object.assign(paint, { ...ink, "text-color": C.ink2 });
        return l;
      case "water_label_lakes":
      case "water_label_ocean":
      case "water_waterway_label":
        Object.assign(layout, { "text-field": NAME, "text-font": [FONT_HEAVY], "text-letter-spacing": 0.08 });
        Object.assign(paint, { "text-color": "#ffffff", "text-halo-color": "#1e7fc7", "text-halo-width": 2.4 });
        return l;
      case "places_region":
      case "places_country":
      case "earth_label_islands":
        Object.assign(layout, { "text-field": NAME, "text-font": [FONT_BOLD] });
        Object.assign(paint, { ...ink, "text-color": "#8a7fb8" });
        return l;
      case "address_label":
        layout["text-font"] = [FONT_BOLD];
        Object.assign(paint, { "text-color": "#a08c70" });
        return l;
      default:
        return null; // remaining symbol layers need the Protomaps sprite sheet
    }
  }
  return l;
}

/** Extra art layers inserted right after a basemap layer id. */
const EXTRAS: Record<string, Layer[]> = {
  landcover: [
    {
      // Colour zoning: the city reads as districts, like an illustrated town map.
      id: "art-zoning",
      type: "fill",
      source: "protomaps",
      "source-layer": "landuse",
      minzoom: 9,
      filter: ["in", ["get", "kind"], ["literal", ["residential", "commercial", "retail", "industrial", "university", "college", "school"]]],
      paint: {
        "fill-color": ["match", ["get", "kind"],
          "residential", C.residential,
          ["commercial", "retail"], C.commercial,
          "industrial", C.industrial,
          C.school],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 12, 1],
      },
    },
    {
      id: "art-zoning-hatch",
      type: "fill",
      source: "protomaps",
      "source-layer": "landuse",
      minzoom: 13,
      filter: ["in", ["get", "kind"], ["literal", ["commercial", "retail"]]],
      paint: { "fill-pattern": "tex-hatch", "fill-opacity": 0.8 },
    },
  ],
  landuse_park: [
    {
      id: "art-park-trees",
      type: "fill",
      source: "protomaps",
      "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", PARKISH]],
      minzoom: 11,
      paint: { "fill-pattern": "tex-trees", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 13, 1] },
    },
    {
      id: "art-park-edge",
      type: "line",
      source: "protomaps",
      "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", PARKISH]],
      minzoom: 11,
      paint: { "line-color": "#3e9e4f", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 15, 2] },
    },
  ],
  water: [
    {
      // Shallows: a wide pale band hugging the shore on the water side.
      id: "art-water-shallows",
      type: "line",
      source: "protomaps",
      "source-layer": "water",
      filter: POLYGON,
      minzoom: 8,
      paint: {
        "line-color": C.shallows,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 12, 8, 16, 16],
        "line-offset": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 4, 16, 8],
      },
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
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 16, 2.5],
        "line-offset": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 16, 4],
      },
    },
    {
      id: "art-water-texture",
      type: "fill",
      source: "protomaps",
      "source-layer": "water",
      filter: POLYGON,
      paint: { "fill-pattern": "tex-water", "fill-opacity": 0.9 },
    },
    {
      id: "art-water-ink",
      type: "line",
      source: "protomaps",
      "source-layer": "water",
      filter: POLYGON,
      minzoom: 7,
      paint: { "line-color": C.shore, "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.8, 12, 1.8, 16, 2.6] },
    },
  ],
};

/** Buildings: flat footprints at district level (extrusions are drawn above the roads). */
const BUILDINGS: Layer[] = [
  {
    id: "art-building-flat",
    type: "fill",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 13,
    maxzoom: 15,
    paint: { "fill-color": "#f0dcbf", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.4, 14, 0.9] },
  },
  {
    id: "art-building-edge",
    type: "line",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 14,
    paint: { "line-color": "#c3a983", "line-width": 0.8 },
  },
];

/** Above all line work: toon extrusions (real heights), then real street trees and landmark
 * stickers (low density). */
const ON_TOP: Layer[] = [
  {
    id: "art-building-3d",
    type: "fill-extrusion",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 14.5,
    paint: {
      // Toy-town pastels for low-rise (varied per building), pale glass for towers.
      "fill-extrusion-color": ["case",
        [">=", ["coalesce", ["get", "height"], 8], 45],
        ["match", ["%", ["round", ["coalesce", ["get", "height"], 0]], 3], 0, "#d9ecff", 1, "#c6e2ff", "#d2f3ff"],
        ["match", ["%", ["round", ["coalesce", ["get", "height"], 0]], 4], 0, "#ffe9c7", 1, "#ffd9df", 2, "#d6f3df", "#ece0ff"]],
      "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14.5, 0, 15.2, ["coalesce", ["get", "height"], 8]],
      "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
      "fill-extrusion-opacity": 0.95,
      "fill-extrusion-vertical-gradient": false,
    },
  },
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
      "text-font": [FONT_BOLD],
      "text-size": 11.5,
      "text-anchor": "top",
      "text-offset": [0, 1.25],
      "text-max-width": 8,
      "text-optional": true,
    },
    paint: { "text-color": INK, "text-halo-color": "#ffffff", "text-halo-width": 2.2 },
  },
];

/** Anime sky for the tilted camera: deep blue overhead, creamy horizon. */
const SKY = {
  "sky-color": "#3fb0ff",
  "horizon-color": "#fff4dc",
  "sky-horizon-blend": 0.75,
  "horizon-fog-blend": 0.6,
  "fog-color": "#d9f0ff",
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
  // Landmarks go below the place labels so city plates win collisions.
  const firstLabel = out.findIndex((l) => l.id === "places_subplace");
  out.splice(firstLabel < 0 ? out.length : firstLabel, 0, ...ON_TOP);
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    "font-faces": FONT_FACES,
    sky: SKY,
    // Strong warm key light so extruded walls separate into lit / shaded faces (toon look).
    light: { anchor: "viewport", color: "#ffffff", intensity: 0.28, position: [1.2, 200, 30] },
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
