/** Count -> body height (spec §7.2). Square-root, monotonic, with one fixed scale per
 * playback: `scaleMax` is the largest city count over the whole history of the selected
 * occupation and window (from the API), never re-normalised per frame. MAX_HEIGHT is the
 * height at count = scaleMax, not a cap: larger counts grow taller. */
export const MAX_HEIGHT = 1350; // scene units (km of the map)

export function heightFor(count: number | null | undefined, scaleMax: number): number {
  if (count == null || count <= 0 || scaleMax <= 0) return 0;
  return MAX_HEIGHT * Math.sqrt(count / scaleMax);
}

/** Legend ticks: counts whose heights are evenly spaced (shows the non-linear scale). */
export function legendTicks(scaleMax: number, steps = 4): number[] {
  if (scaleMax <= 0) return [];
  const out: number[] = [];
  for (let i = 1; i <= steps; i++) {
    const c = Math.round(scaleMax * (i / steps) ** 2);
    if (c > 0 && !out.includes(c)) out.push(c);
  }
  return out;
}
