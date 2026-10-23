/** No WebGL: a flat SVG map in the same palette, with square-root bars, never a blank page. */
import type { City } from "../api";
import { project } from "../projection";
import type { GeoData } from "../scene/AtlasScene";
import { CEL } from "../scene/palette";
import { heightFor, MAX_HEIGHT } from "../scale";
import s from "./atlas.module.css";

export function FallbackMap(p: {
  geo: GeoData;
  preparing?: boolean;
  cities: City[];
  counts: Map<string, number | null>;
  scaleMax: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [minX, minY, maxX, maxY] = p.geo.bbox;
  const path = (rings: [number, number][][]) => rings.map((r) => "M" + r.map(([x, y]) => `${x},${-y}`).join("L") + "Z").join("");
  return (
    <div className={s.fallback}>
      <p className={s.fallbackNote}>{p.preparing ? "Preparing interactive map…" : "2D view: WebGL is not available in this browser."}</p>
      <svg viewBox={`${minX - 100} ${-maxY - 300} ${maxX - minX + 200} ${maxY - minY + 400}`} role="img" aria-label={p.preparing ? "Map of Canada (interactive view loading)" : "Map of Canada (2D view: WebGL is not available)"}>
        {p.geo.provinces.map((pr) =>
          pr.polygons.map((poly, i) => <path key={`${pr.code}${i}`} d={path(poly)} fill={CEL.landLight} stroke={CEL.ink} strokeWidth={4} strokeLinejoin="round" />),
        )}
        {p.geo.lakes.map((poly, i) => (
          <path key={`l${i}`} d={path(poly)} fill={CEL.lake} stroke={CEL.inkMuted} strokeWidth={2} />
        ))}
        {p.cities.map((c) => {
          const n = p.counts.get(c.city_id);
          const [x, y] = project(c.lon, c.lat);
          const h = (heightFor(n, p.scaleMax) / MAX_HEIGHT) * 400;
          const sel = c.city_id === p.selected;
          return (
            <g key={c.city_id} onClick={() => p.onSelect(c.city_id)} style={{ cursor: "pointer" }}>
              {n == null ? (
                <circle cx={x} cy={-y} r={9} fill="none" stroke={CEL.unknown} strokeWidth={3} />
              ) : n === 0 ? (
                <circle cx={x} cy={-y} r={6} fill={CEL.zero} />
              ) : (
                <rect x={x - 8} y={-y - h} width={16} height={Math.max(h, 4)} rx={8} fill={CEL.dataLight} stroke={CEL.ink} strokeWidth={sel ? 5 : 3} />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
