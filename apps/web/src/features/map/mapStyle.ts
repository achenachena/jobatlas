/** Self-hosted, anime-inspired basemap (DEVELOPMENT.md §8, §10).
 *
 * Tiles: a GTA extract of the Protomaps OpenStreetMap build served as one PMTiles file
 * (VITE_MAP_TILES_URL); glyphs are self-hosted Noto Sans (OFL). No third-party tile or font
 * servers are contacted. Data © OpenStreetMap contributors (ODbL).
 */
import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";
import type { StyleSpecification } from "maplibre-gl";

export const TILES_URL: string =
  (import.meta.env.VITE_MAP_TILES_URL as string | undefined) ?? "/tiles/gta.pmtiles";
export const GLYPHS_URL: string =
  (import.meta.env.VITE_MAP_GLYPHS_URL as string | undefined) ??
  `${location.origin}/tiles/fonts/{fontstack}/{range}.pbf`;

/** Pastel "city exploration" palette layered over Protomaps' light flavour. */
export const animeFlavor: Flavor = {
  ...namedFlavor("light"),
  background: "#f1eefc",
  earth: "#f6f4fd",
  water: "#b9defc",
  park_a: "#d3f1de",
  park_b: "#c3ebd2",
  wood_a: "#cdeed8",
  wood_b: "#bfe6cc",
  scrub_a: "#dcf3e3",
  scrub_b: "#d2efdc",
  hospital: "#fde8f1",
  school: "#f1ecff",
  industrial: "#eeebf7",
  zoo: "#d9f4e4",
  aerodrome: "#ece9f7",
  beach: "#fff3d6",
  sand: "#fbefd7",
  pedestrian: "#f4f0ff",
  buildings: "#e6e0f8",
  pier: "#ece7fb",
  railway: "#c9c1ee",
  boundaries: "#b9b0e6",
  minor_a: "#ffffff",
  minor_b: "#ffffff",
  minor_service: "#ffffff",
  other: "#ffffff",
  link: "#ffffff",
  major: "#ffffff",
  highway: "#ffe1b5",
  minor_casing: "#e3dcf6",
  minor_service_casing: "#e9e4f8",
  link_casing: "#dcd4f3",
  major_casing_early: "#d9d1f2",
  major_casing_late: "#d9d1f2",
  highway_casing_early: "#f3c98a",
  highway_casing_late: "#f3c98a",
  roads_label_minor: "#6f6aa3",
  roads_label_minor_halo: "#ffffff",
  roads_label_major: "#5a5592",
  roads_label_major_halo: "#ffffff",
  city_label: "#2c2867",
  city_label_halo: "#ffffff",
  subplace_label: "#6a5cf0",
  subplace_label_halo: "#ffffff",
  ocean_label: "#4c86c7",
  state_label: "#8b86bd",
  state_label_halo: "#ffffff",
  country_label: "#8b86bd",
  address_label: "#8b86bd",
  address_label_halo: "#ffffff",
};

export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${TILES_URL}`,
        attribution:
          '<a href="https://openstreetmap.org/copyright">© OpenStreetMap contributors</a> · <a href="https://protomaps.com">Protomaps</a>',
      },
    },
    // Basemap layers that need sprite icons (POIs, highway shields) are dropped: we ship no
    // sprite sheet. Road and place names still come from text labels.
    layers: layers("protomaps", animeFlavor, { lang: "en" }).filter(
      (l) => !("layout" in l && l.layout && "icon-image" in l.layout),
    ),
  } as StyleSpecification;
}
