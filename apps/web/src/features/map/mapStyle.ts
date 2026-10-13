/** "Painted Summer Town" basemap (docs/visual-redesign.md): the GTA painted like an
 * anime-film background (Ghibli / Shinkai) on a summer afternoon, seen as a 2.5D illustration.
 *
 * Tiles: a GTA extract of the Protomaps OpenStreetMap build served as one PMTiles file
 * (VITE_MAP_TILES_URL). Labels use the bundled M PLUS Rounded 1c web font through the style's
 * `font-faces` (drawn client-side); `glyphs` (self-hosted Noto Sans) is only a fallback
 * outside Latin. No third-party servers. Data © OpenStreetMap contributors (ODbL).
 *
 * Painted, not rendered:
 *  - ground, parks and water are brush-textured (canvas-painted patterns, markerImages.ts):
 *    a warm wash for land, lush tree crowns for parks, turquoise water with sun glints;
 *  - buildings keep the real OSM silhouettes and heights (native fill-extrusion, tiled on the
 *    GPU) but are faced with painted walls — cream and white low-rise, sky-glass towers —
 *    under warm afternoon light with cool blue shadows;
 *  - roads are pale cream ribbons with soft warm edges; no black lines anywhere;
 *  - the sky is NOT drawn by the map: above the horizon the canvas stays transparent and
 *    the hand-painted sky behind it (PaintedSky.tsx) shows through; a pale haze softens the
 *    far city into it.
 * Every road, shoreline, building and POI stays where OSM puts it. */
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
/** Counts and captions use the heavy rounded face (no comic display face in this style). */
export const FONT_DISPLAY = FONT_HEAVY;
const face = (latin: string, ext: string) => [
  { url: abs(latin), "unicode-range": LATIN },
  { url: abs(ext), "unicode-range": LATIN_EXT },
];
const FONT_FACES = {
  [FONT_BOLD]: face(rounded700, rounded700ext),
  [FONT_HEAVY]: face(rounded800, rounded800ext),
};

const ROAD = C.road;
const EDGE = C.roadEdge;
const flavor: Flavor = {
  ...namedFlavor("light"),
  background: "rgba(0,0,0,0)", // above the horizon: transparent, the painted sky shows through
  earth: C.land,
  park_a: C.grass,
  park_b: C.grass,
  wood_a: "#86c96a",
  wood_b: "#86c96a",
  scrub_a: "#b5df8c",
  scrub_b: "#b5df8c",
  glacier: "#ffffff",
  sand: "#f7e6b8",
  beach: "#f7e6b8",
  hospital: C.land,
  school: C.land,
  industrial: "#ebe3d2",
  zoo: C.grass,
  aerodrome: "#efe8d6",
  runway: "#ffffff",
  pedestrian: "#fbf3e2",
  pier: "#f2e7cf",
  military: C.land,
  water: C.water,
  buildings: "#fff3dc",
  other: ROAD,
  minor_service: ROAD,
  minor_a: ROAD,
  minor_b: ROAD,
  link: ROAD,
  major: ROAD,
  highway: "#fff1cf",
  minor_service_casing: EDGE,
  minor_casing: EDGE,
  link_casing: EDGE,
  major_casing_early: EDGE,
  major_casing_late: EDGE,
  highway_casing_early: "#e8c98a",
  highway_casing_late: "#e8c98a",
  bridges_other_casing: EDGE,
  bridges_minor_casing: EDGE,
  bridges_link_casing: EDGE,
  bridges_major_casing: EDGE,
  bridges_highway_casing: "#e8c98a",
  bridges_other: ROAD,
  bridges_minor: ROAD,
  bridges_link: ROAD,
  bridges_major: ROAD,
  bridges_highway: "#fff1cf",
  tunnel_other_casing: EDGE,
  tunnel_minor_casing: EDGE,
  tunnel_link_casing: EDGE,
  tunnel_major_casing: EDGE,
  tunnel_highway_casing: EDGE,
  tunnel_other: "#f6efe0",
  tunnel_minor: "#f6efe0",
  tunnel_link: "#f6efe0",
  tunnel_major: "#f6efe0",
  tunnel_highway: "#f6efe0",
  railway: "#c7b48f",
  boundaries: "#cdbf9f",
  landcover: {
    grassland: "rgba(181, 223, 140, 1)",
    barren: "rgba(240, 230, 205, 1)",
    urban_area: "rgba(243, 236, 214, 1)",
    farmland: "rgba(214, 228, 150, 1)",
    glacier: "rgba(255, 255, 255, 1)",
    scrub: "rgba(181, 223, 140, 1)",
    forest: "rgba(120, 190, 100, 1)",
  },
};

type Layer = LayerSpecification;
type Exp = ExpressionSpecification;
const POLYGON: Exp = ["==", ["geometry-type"], "Polygon"];
const NAME: Exp = ["coalesce", ["get", "name:en"], ["get", "name"]];
const HEIGHT: Exp = ["coalesce", ["get", "height"], 8];
const PARKISH = ["park", "national_park", "nature_reserve", "golf_course", "forest", "wood", "garden", "recreation_ground", "cemetery", "grass", "meadow"];

function tune(layer: Layer): Layer | null {
  const l = structuredClone(layer) as Layer & { layout?: Record<string, unknown>; paint?: Record<string, unknown>; minzoom?: number };
  const id = l.id;
  const paint = (l.paint ??= {}) as Record<string, unknown>;
  const layout = (l.layout ??= {}) as Record<string, unknown>;

  if (/^roads_(minor|minor_service|other|link)(_casing)?$/.test(id) || /^roads_bridges_(minor|other|link)/.test(id)) {
    l.minzoom = Math.max(l.minzoom ?? 0, id.includes("other") ? 15 : 12.5);
  }
  if (/^roads_tunnels_/.test(id)) l.minzoom = Math.max(l.minzoom ?? 0, 14);
  if (id === "roads_rail") {
    paint["line-dasharray"] = [3, 2];
    paint["line-width"] = ["interpolate", ["linear"], ["zoom"], 10, 0.8, 16, 2];
    paint["line-opacity"] = 0.7;
  }

  if (l.type === "symbol") {
    const halo = { "text-halo-color": "rgba(255,250,236,0.95)", "text-halo-width": 2, "text-halo-blur": 0.8 };
    switch (id) {
      case "places_locality":
        for (const k of ["icon-image", "icon-size", "icon-padding", "text-radial-offset", "text-variable-anchor", "text-justify"]) delete layout[k];
        Object.assign(layout, {
          "text-field": NAME,
          "text-font": [FONT_HEAVY],
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, ["step", ["get", "population_rank"], 10, 9, 14], 12, ["step", ["get", "population_rank"], 12, 9, 19]],
          "text-letter-spacing": 0.06,
          "text-padding": 14,
        });
        Object.assign(paint, { ...halo, "text-color": INK, "text-halo-width": 2.6 });
        return l;
      case "places_subplace":
        Object.assign(layout, {
          "text-field": NAME,
          "text-font": [FONT_BOLD],
          "text-transform": "none",
          "text-letter-spacing": 0.03,
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10.5, 14, 13, 17, 15],
          "text-padding": ["interpolate", ["linear"], ["zoom"], 11, 30, 14, 22],
        });
        Object.assign(paint, { ...halo, "text-color": C.ink2, "text-opacity": ["interpolate", ["linear"], ["zoom"], 10.5, 0, 11.5, 1] });
        return l;
      case "roads_labels_major":
      case "roads_labels_minor":
        Object.assign(layout, { "text-field": NAME, "text-font": [FONT_BOLD], "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10.5, 16, 13] });
        Object.assign(paint, { ...halo, "text-color": "#6b6450" });
        return l;
      case "water_label_lakes":
      case "water_label_ocean":
      case "water_waterway_label":
        Object.assign(layout, { "text-field": NAME, "text-font": [FONT_BOLD], "text-letter-spacing": 0.25, "text-size": 12 });
        Object.assign(paint, { "text-color": "#ffffff", "text-halo-color": "rgba(42,150,207,0.8)", "text-halo-width": 1.6 });
        return l;
      case "places_region":
      case "places_country":
      case "earth_label_islands":
        Object.assign(layout, { "text-field": NAME, "text-font": [FONT_BOLD] });
        Object.assign(paint, { ...halo, "text-color": "#8a8370" });
        return l;
      default:
        return null; // address numbers and sprite-based layers are dropped
    }
  }
  return l;
}

/** Painted texture layers inserted right after a basemap layer. */
const EXTRAS: Record<string, Layer[]> = {
  earth: [
    { id: "paint-land", type: "fill", source: "protomaps", "source-layer": "earth", paint: { "fill-pattern": "paint-land" } },
  ],
  landuse_park: [
    {
      id: "paint-parks",
      type: "fill",
      source: "protomaps",
      "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", PARKISH]],
      minzoom: 10,
      paint: { "fill-pattern": "paint-grass", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 12, 1] },
    },
  ],
  water: [
    { id: "paint-water", type: "fill", source: "protomaps", "source-layer": "water", filter: POLYGON, paint: { "fill-pattern": "paint-water" } },
  ],
};

/** Buildings: real silhouettes with painted facades, banded by real height. */
const BUILDINGS: Layer[] = [
  {
    id: "art-buildings",
    type: "fill-extrusion",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 12.5,
    paint: {
      "fill-extrusion-pattern": ["step", HEIGHT, "facade-low", 25, "facade-mid", 80, "facade-tall"],
      "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 12.5, 0, 13.5, HEIGHT],
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
    paint: { "text-color": INK, "text-halo-color": "rgba(255,250,236,0.95)", "text-halo-width": 2 },
  },
];

/** No painted sky here (sky-color is transparent); the haze softens the far city. */
const SKY = {
  "sky-color": "rgba(0,0,0,0)",
  "horizon-color": "rgba(255,246,228,0)",
  "sky-horizon-blend": 0,
  // the far city dissolves into the warm summer haze that the painted sky ends in
  "horizon-fog-blend": 0.9,
  "fog-color": "#ecf4ff",
  "fog-ground-blend": 0.12,
  "atmosphere-blend": 0,
};

/** Warm afternoon sun from the south-west. */
const LIGHT = { anchor: "viewport", color: "#fff4e0", intensity: 0.22, position: [1.15, 210, 40] };

export function buildStyle(): StyleSpecification {
  const out: Layer[] = [];
  for (const layer of layers("protomaps", flavor, { lang: "en" }) as Layer[]) {
    if (layer.id === "buildings") continue;
    const tuned = tune(layer);
    if (tuned) out.push(tuned);
    out.push(...(EXTRAS[layer.id] ?? []));
  }
  const firstLabel = out.findIndex((l) => l.type === "symbol");
  out.splice(firstLabel < 0 ? out.length : firstLabel, 0, ...BUILDINGS, ...ON_TOP);
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
