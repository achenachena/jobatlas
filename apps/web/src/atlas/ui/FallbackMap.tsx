/** No WebGL: a flat SVG map with proportional (square-root) bars, never a blank page. */
import type { City } from "../api";
import { project } from "../projection";
import type { GeoData } from "../scene/AtlasScene";
import { heightFor, MAX_HEIGHT, colorFor } from "../scale";
import s from "./atlas.module.css";

export function FallbackMap(p: { geo: GeoData; cities: City[]; counts: Map<string, number | null>; scaleMax: number; onSelect: (id: string) => void }) {
  const [minX, minY, maxX, maxY] = p.geo.bbox;
  const path = (rings: [number, number][][]) => rings.map((r) => "M" + r.map(([x, y]) => `${x},${-y}`).join("L") + "Z").join("");
  return (
    <div className={s.fallback}>
      <svg viewBox={`${minX - 100} ${-maxY - 300} ${maxX - minX + 200} ${maxY - minY + 400}`} role="img" aria-label="Map of Canada (2D view: WebGL is not available)">
        <rect x={minX - 3000} y={-maxY - 3000} width={20000} height={20000} fill="#fcf6ed" />
        {p.geo.neighbours.map((poly, i) => (
          <path key={`n${i}`} d={path(poly)} fill="#e6e1d8" stroke="#5d6084" strokeWidth={4} />
        ))}
        {p.geo.provinces.map((pr) => pr.polygons.map((poly, i) => <path key={`${pr.code}${i}`} d={path(poly)} fill="#e3edcf" stroke="#26284a" strokeWidth={5} />))}
        {p.cities.map((c) => {
          const n = p.counts.get(c.city_id);
          const [x, y] = project(c.lon, c.lat);
          const h = (heightFor(n, p.scaleMax) / MAX_HEIGHT) * 400;
          return (
            <g key={c.city_id} onClick={() => p.onSelect(c.city_id)} style={{ cursor: "pointer" }}>
              {n == null ? (
                <circle cx={x} cy={-y} r={10} fill="none" stroke="#26284a" strokeWidth={3} strokeDasharray="6 4" />
              ) : (
                <rect x={x - 7} y={-y - h} width={14} height={Math.max(h, 2)} fill={colorFor(n, p.scaleMax)} stroke="#26284a" strokeWidth={3} />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
