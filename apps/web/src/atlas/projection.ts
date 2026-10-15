/** Lambert conformal conic for Canada (Statistics Canada EPSG:3347 parameters), in km.
 * Must match scripts/build-atlas-geo.mjs, which projected the outlines. */
const R = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;
const phi1 = rad(49);
const phi2 = rad(77);
const phi0 = rad(63.390675);
const lam0 = rad(-91.866667);
const n =
  Math.log(Math.cos(phi1) / Math.cos(phi2)) /
  Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
const F = (Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n)) / n;
const rho = (phi: number) => (R * F) / Math.pow(Math.tan(Math.PI / 4 + phi / 2), n);
const rho0 = rho(phi0);

/** [x east, y north] in km. */
export function project(lon: number, lat: number): [number, number] {
  const r = rho(rad(lat));
  const t = n * (rad(lon) - lam0);
  return [r * Math.sin(t), rho0 - r * Math.cos(t)];
}
