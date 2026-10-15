/** Count -> crystal height (spec §7.2). Square-root, monotonic, with one fixed scale per
 * playback: `scaleMax` is the largest city count over the whole history of the selected
 * occupation and window (from the API), never re-normalised per frame. */
export const MAX_HEIGHT = 2400; // scene units (km of the map) for the tallest crystal

export function heightFor(count: number | null | undefined, scaleMax: number): number {
  if (count == null || count <= 0 || scaleMax <= 0) return 0;
  return (MAX_HEIGHT * Math.sqrt(count)) / Math.sqrt(scaleMax);
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

/** Sequential colour encodes the same fixed square-root scale as height, never city identity. */
export const POSTING_COLORS = ["#ffe7b3", "#f28a65", "#ad335a"] as const;
export function colorFor(count: number | null | undefined, scaleMax: number): string {
  const t = count == null || count <= 0 || scaleMax <= 0 ? 0 : Math.min(1, Math.sqrt(count / scaleMax));
  const index = t < 0.5 ? 0 : 1;
  const mix = (t - index * 0.5) * 2;
  const a = POSTING_COLORS[index]!;
  const b = POSTING_COLORS[index + 1]!;
  const channels = [1, 3, 5].map((offset) => Math.round(
    parseInt(a.slice(offset, offset + 2), 16) * (1 - mix) + parseInt(b.slice(offset, offset + 2), 16) * mix,
  ).toString(16).padStart(2, "0"));
  return `#${channels.join("")}`;
}
