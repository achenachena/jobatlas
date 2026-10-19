/** "Clear Cel" art direction. One look; colours are the finished cel tones, line widths are
 * CSS pixels. */
export const CEL = {
  paper: "#ffffff",
  ink: "#172b70",
  inkMuted: "#657ba8",
  provinceLine: "#b3cddd",
  landLight: "#e8f8fa",
  landSide: "#8bbce4",
  lake: "#a0c6df",
  dataLight: "#6edac6",
  dataShadow: "#358da9",
  dataTop: "#edfff9",
  dataGlow: "#adf5e7",
  dataInk: "#263d91",
  contactShadow: "#9dbcdc",
  zero: "#a9c8e0",
  unknown: "#7f91aa",
  line: { data: 1.25, selected: 2.2, coast: 0.85, island: 0.65, province: 0.35 },
  elevation: 38,
  azimuth: -12,
  landDepth: 45,
  shadowOpacity: 0.45,
  cel: { threshold: 0.22, feather: 0.025 },
  /** normalised [x, y, w, h] the land and body tips fit into, and where the map centres */
  safeDesktop: [0.005, 0.065, 0.99, 0.85],
  centreDesktop: [0.5, 0.485],
  safeMobile: [0.005, 0.1, 0.99, 0.76],
  /** Zoom at which the city layer replaces the groups, and below which the groups return.
   * Measured at 1440×900, default angle: the GTA cities' closest pair is 10.7 px apart at 3×
   * and 9.0 px at 2.5×, so 8 px bars stand apart across the whole hysteresis band. */
  detail: { enterCities: 3, exitCities: 2.5 },
  motion: { height: 450, focus: 320 },
} as const;
