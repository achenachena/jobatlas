/** Art direction for the two drafts (spec §7.1). Draft A "Diorama" is the chosen look; draft
 * B "Manga panel" is kept as the alternative composition (?draft=b). */
export interface ScenePalette {
  name: "diorama" | "panel";
  background: string;
  sea: string;
  seaInk: string;
  landTop: string;
  landSide: string;
  neighbourTop: string;
  neighbourSide: string;
  lake: string;
  ink: string;
  provinceInk: string;
  mountain: string;
  snow: string;
  shadow: string;
  windows: string;
  zeroPad: string;
  /** camera: degrees above the horizon and around the vertical axis (0 = from the south). */
  elevation: number;
  azimuth: number;
  landDepth: number;
  coastWidth: number;
  provinceWidth: number;
}

export const DIORAMA: ScenePalette = {
  name: "diorama",
  background: "#fcf6ed",
  sea: "#fcf6ed",
  seaInk: "#e9ddd6",
  landTop: "#e3edcf",
  landSide: "#afa3c5",
  neighbourTop: "#e6e1d8",
  neighbourSide: "#c9c0b2",
  lake: "#a7dce5",
  ink: "#30304b",
  provinceInk: "#9693a1",
  mountain: "#a9cbbd",
  snow: "#ffffff",
  shadow: "#7f93bd",
  windows: "#3e5594",
  zeroPad: "#fffaf0",
  elevation: 38,
  azimuth: 8,
  landDepth: 65,
  coastWidth: 2.1,
  provinceWidth: 0.8,
};

export const PANEL: ScenePalette = {
  name: "panel",
  background: "#fbfaf6",
  sea: "#e9edf2",
  seaInk: "#9aa6b8",
  landTop: "#ffffff",
  landSide: "#1d1d26",
  neighbourTop: "#f1f1ee",
  neighbourSide: "#55555f",
  lake: "#e3e8ee",
  ink: "#111118",
  provinceInk: "#3a3a46",
  mountain: "#d9d9de",
  snow: "#ffffff",
  shadow: "#c8ccd6",
  windows: "#111118",
  zeroPad: "#ffffff",
  elevation: 64,
  azimuth: 0,
  landDepth: 28,
  coastWidth: 3.6,
  provinceWidth: 1.6,
};
