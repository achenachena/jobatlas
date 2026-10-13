/** "Twilight City" basemap (docs/visual-redesign.md): the GTA as an anime-film city at dusk.
 *
 * Tiles: a GTA extract of the Protomaps OpenStreetMap build served as one PMTiles file
 * (VITE_MAP_TILES_URL). Labels use bundled web fonts through the style's `font-faces` (drawn
 * client-side): Dela Gothic One for city captions, M PLUS Rounded 1c for everything else.
 * `glyphs` (self-hosted Noto Sans) is only a fallback outside Latin. No third-party servers.
 * Data © OpenStreetMap contributors (ODbL).
 *
 * Refined but abstract: real silhouettes, no materials beyond lit windows.
 *  - buildings: the real OSM footprints and heights as plain massing (native fill-extrusion,
 *    tiled on the GPU — nothing is rebuilt while the map moves), faced with a window texture
 *    (indigo -> violet with height, a share of windows lit warm), under a soft sunset key
 *    light from the west;
 *  - streets as light: arterials and motorways glow (blurred halo + bright core) like traffic
 *    at dusk; side streets are faint;
 *  - ground, parks and water in deep, close values so the light reads;
 *  - a sunset sky with horizon fog when the camera is tilted;
 *  - labels in pale lavender with a dark halo; cities as small captions.
 * Every road, shoreline, building and POI stays where OSM puts it. */
import dela from "@fontsource/dela-gothic-one/files/dela-gothic-one-latin-400-normal.woff2?url";
import delaExt from "@fontsource/dela-gothic-one/files/dela-gothic-one-latin-ext-400-normal.woff2?url";
import rounded700 from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-700-normal.woff2?url";
import rounded700ext from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-ext-700-normal.woff2?url";
import rounded800 from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-800-normal.woff2?url";
import rounded800ext from "@fontsource/m-plus-rounded-1c/files/m-plus-rounded-1c-latin-ext-800-normal.woff2?url";
import { type Flavor, layers, namedFlavor } from "@protomaps/basemaps";
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";

import { C, PAPER } from "../../theme/palette";
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

const GROUND = C.night;
const flavor: Flavor = {
  ...namedFlavor("dark"),
  background: "#0e1130",
  earth: GROUND,
  park_a: C.park,
  park_b: C.park,
  wood_a: "#163044",
  wood_b: "#163044",
  scrub_a: "#172d44",
  scrub_b: "#172d44",
  glacier: "#2a3166",
  sand: "#2a2c55",
  beach: "#2d2d58",
  hospital: GROUND,
  school: GROUND,
  industrial: GROUND,
  zoo: C.park,
  aerodrome: "#171c40",
  runway: "#262c5c",
  pedestrian: "#1b2048",
  pier: "#232a5a",
  military: GROUND,
  water: C.water,
  buildings: C.dusk,
  other: "#232a58",
  minor_service: "#232a58",
  minor_a: "#262d60",
  minor_b: "#262d60",
  link: "#3a3f7a",
  major: "#3a3f7a",
  highway: "#4a4a86",
  minor_service_casing: GROUND,
  minor_casing: GROUND,
  link_casing: GROUND,
  major_casing_early: GROUND,
  major_casing_late: GROUND,
  highway_casing_early: GROUND,
  highway_casing_late: GROUND,
  bridges_other_casing: GROUND,
  bridges_minor_casing: GROUND,
  bridges_link_casing: GROUND,
  bridges_major_casing: GROUND,
  bridges_highway_casing: GROUND,
  bridges_other: "#232a58",
  bridges_minor: "#262d60",
  bridges_link: "#3a3f7a",
  bridges_major: "#3a3f7a",
  bridges_highway: "#4a4a86",
  tunnel_other_casing: GROUND,
  tunnel_minor_casing: GROUND,
  tunnel_link_casing: GROUND,
  tunnel_major_casing: GROUND,
  tunnel_highway_casing: GROUND,
  tunnel_other: "#1b2048",
  tunnel_minor: "#1b2048",
  tunnel_link: "#1b2048",
  tunnel_major: "#1b2048",
  tunnel_highway: "#1b2048",
  railway: "#3c3f78",
  boundaries: "#3c3f78",
  landcover: {
    grassland: "rgba(23, 45, 68, 1)",
    barren: "rgba(22, 26, 58, 1)",
    urban_area: "rgba(20, 24, 56, 1)",
    farmland: "rgba(24, 40, 62, 1)",
    glacier: "rgba(42, 49, 102, 1)",
    scrub: "rgba(23, 45, 68, 1)",
    forest: "rgba(21, 44, 64, 1)",
  },
};

type Layer = LayerSpecification;
type Exp = ExpressionSpecification;
const POLYGON: Exp = ["==", ["geometry-type"], "Polygon"];
const NAME: Exp = ["coalesce", ["get", "name:en"], ["get", "name"]];
const HEIGHT: Exp = ["coalesce", ["get", "height"], 8];

function tune(layer: Layer): Layer | null {
  const l = structuredClone(layer) as Layer & { layout?: Record<string, unknown>; paint?: Record<string, unknown>; minzoom?: number };
  const id = l.id;
  const paint = (l.paint ??= {}) as Record<string, unknown>;
  const layout = (l.layout ??= {}) as Record<string, unknown>;

  // Side streets and paths only near street level; they stay faint.
  if (/^roads_(minor|minor_service|other|link)(_casing)?$/.test(id) || /^roads_bridges_(minor|other|link)/.test(id)) {
    l.minzoom = Math.max(l.minzoom ?? 0, id.includes("other") ? 15 : 12.5);
  }
  if (/^roads_tunnels_/.test(id)) l.minzoom = Math.max(l.minzoom ?? 0, 14);
  if (/_casing/.test(id)) return null; // streets are lights, not drawn strips
  if (id === "roads_rail") {
    paint["line-color"] = "#4b4f8f";
    paint["line-dasharray"] = [2, 2];
    paint["line-width"] = ["interpolate", ["linear"], ["zoom"], 10, 0.6, 16, 1.6];
  }

  if (l.type === "symbol") {
    const halo = { "text-halo-color": "rgba(13,16,48,0.9)", "text-halo-width": 1.8, "text-halo-blur": 0.6 };
    switch (id) {
      case "places_locality":
        for (const k of ["icon-image", "icon-size", "icon-padding", "text-radial-offset", "text-variable-anchor", "text-justify"]) delete layout[k];
        Object.assign(layout, {
          "text-field": NAME,
          "text-font": ["step", ["get", "population_rank"], ["literal", [FONT_HEAVY]], 9, ["literal", [FONT_DISPLAY]]],
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, ["step", ["get", "population_rank"], 10, 9, 13], 12, ["step", ["get", "population_rank"], 12, 9, 18]],
          "text-letter-spacing": 0.08,
          "text-transform": "uppercase",
          "text-padding": 14,
        });
        Object.assign(paint, { ...halo, "text-color": PAPER, "text-halo-width": 2.4 });
        return l;
      case "places_subplace":
        Object.assign(layout, {
          "text-field": NAME,
          "text-font": [FONT_BOLD],
          "text-transform": "none",
          "text-letter-spacing": 0.04,
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10.5, 14, 13, 17, 15],
          "text-padding": ["interpolate", ["linear"], ["zoom"], 11, 30, 14, 22],
        });
        Object.assign(paint, { ...halo, "text-color": C.lavender, "text-opacity": ["interpolate", ["linear"], ["zoom"], 10.5, 0, 11.5, 1] });
        return l;
      case "roads_labels_major":
      case "roads_labels_minor":
        Object.assign(layout, { "text-field": NAME, "text-font": [FONT_BOLD], "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10.5, 16, 13] });
        Object.assign(paint, { ...halo, "text-color": "#c9c3ff" });
        return l;
      case "water_label_lakes":
      case "water_label_ocean":
      case "water_waterway_label":
        Object.assign(layout, {
          "text-field": NAME, "text-font": [FONT_BOLD], "text-letter-spacing": 0.35,
          "text-transform": "uppercase", "text-size": 11,
        });
        Object.assign(paint, { ...halo, "text-color": "#5d8fe0", "text-halo-width": 0, "text-opacity": 0.85 });
        return l;
      case "places_region":
      case "places_country":
      case "earth_label_islands":
        Object.assign(layout, { "text-field": NAME, "text-font": [FONT_BOLD] });
        Object.assign(paint, { ...halo, "text-color": "#7c78c0" });
        return l;
      default:
        return null; // address numbers and sprite-based layers are dropped
    }
  }
  return l;
}

/** Zoom curve through (zoom, width) stops, each width scaled by k. */
const curve = (stops: Array<[number, number]>, k = 1): Exp =>
  ["interpolate", ["exponential", 1.5], ["zoom"], ...stops.flatMap(([z, w]) => [z, w * k])] as unknown as Exp;

/** Glowing streets: a wide blurred halo and a thin bright core per class. */
function glow(id: string, filter: Exp, color: string, core: string, stops: Array<[number, number]>, minzoom = 0): Layer[] {
  const base = { type: "line", source: "protomaps", "source-layer": "roads", filter, minzoom } as const;
  return [
    {
      ...base,
      id: `${id}-halo`,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color, "line-width": curve(stops, 4), "line-blur": curve(stops, 3), "line-opacity": 0.35 },
    },
    {
      ...base,
      id: `${id}-core`,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": core, "line-width": curve(stops), "line-opacity": 0.95 },
    },
  ] as Layer[];
}

const STREET_LIGHTS: Layer[] = [
  ...glow(
    "light-major",
    ["==", ["get", "kind"], "major_road"],
    C.peach,
    "#ffd9c2",
    [[9, 0.3], [12, 0.9], [15, 2.2], [18, 5]],
    9,
  ),
  ...glow(
    "light-highway",
    ["==", ["get", "kind"], "highway"],
    C.amber,
    "#fff0c4",
    [[6, 0.5], [10, 1.2], [14, 3], [18, 7]],
  ),
];

// Water: city lights reflected as shimmer (a fill pattern — outline-based effects would also
// trace the tile seams of the clipped water polygons).
const EXTRAS: Record<string, Layer[]> = {
  water: [
    {
      id: "art-water-shimmer",
      type: "fill",
      source: "protomaps",
      "source-layer": "water",
      filter: POLYGON,
      paint: { "fill-pattern": "water-shimmer" },
    },
  ],
};

/** Buildings: real silhouettes as plain massing, coloured by height. */
const BUILDINGS: Layer[] = [
  {
    id: "art-buildings",
    type: "fill-extrusion",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 12,
    paint: {
      // facades with lit windows (markerImages.FACADES), banded by real height
      "fill-extrusion-pattern": ["step", HEIGHT, "facade-low", 25, "facade-mid", 80, "facade-tall"],
      "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 12, 0, 13, HEIGHT],
      "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
      "fill-extrusion-opacity": 1,
      "fill-extrusion-vertical-gradient": true,
    },
  } as Layer,
];

const ON_TOP: Layer[] = [
  {
    id: "art-landmarks",
    type: "symbol",
    source: "protomaps",
    "source-layer": "pois",
    minzoom: 13,
    filter: ["all",
      ["in", ["get", "kind"], ["literal", Object.keys(LANDMARKS)]],
      [">=", ["zoom"], ["+", ["get", "min_zoom"], 1]]],
    layout: {
      "symbol-sort-key": ["get", "min_zoom"],
      "icon-image": ["concat", "lm-", ["get", "kind"]],
      "icon-padding": 12,
      "text-field": ["step", ["zoom"], "", 15, NAME],
      "text-font": [FONT_BOLD],
      "text-size": 11,
      "text-anchor": "top",
      "text-offset": [0, 1.1],
      "text-max-width": 8,
      "text-optional": true,
    },
    paint: { "text-color": PAPER, "text-halo-color": "rgba(13,16,48,0.9)", "text-halo-width": 1.8 },
  },
];

/** Dusk sky: deep blue overhead, sunset peach at the horizon, violet haze over the far city. */
const SKY = {
  "sky-color": "#1c2a78",
  "horizon-color": "#ff9a7a",
  "sky-horizon-blend": 0.55,
  "horizon-fog-blend": 0.8,
  "fog-color": "#4a3b86",
  "fog-ground-blend": 0.35,
  "atmosphere-blend": 0,
};

/** Warm sunset key light, low from the west. */
const LIGHT = { anchor: "map", color: "#ffe1d6", intensity: 0.3, position: [1.25, 255, 58] };

export function buildStyle(): StyleSpecification {
  const out: Layer[] = [];
  for (const layer of layers("protomaps", flavor, { lang: "en" }) as Layer[]) {
    if (layer.id === "buildings") continue; // drawn as extrusions below the labels
    const tuned = tune(layer);
    if (tuned) out.push(tuned);
    out.push(...(EXTRAS[layer.id] ?? []));
  }
  // Street lights, buildings and landmarks go below the place labels.
  const firstLabel = out.findIndex((l) => l.type === "symbol");
  out.splice(firstLabel < 0 ? out.length : firstLabel, 0, ...STREET_LIGHTS, ...BUILDINGS, ...ON_TOP);
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    "font-faces": FONT_FACES,
    sky: SKY,
    light: LIGHT,
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
