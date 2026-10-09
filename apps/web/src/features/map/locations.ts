/** Jobs at exactly the same coordinate become one "stack" feature (same building), so the map
 * can tell a same-address stack apart from a region cluster. Coordinates are never offset or
 * jittered: a stack sits on the real point. */

export interface JobPointProps {
  job_id: string;
  workplace_type: string;
  /** The point is the company's single city office, not an address the job states. */
  inferred?: boolean;
}

export interface LocationProps {
  loc_id: string;
  /** Jobs at this coordinate. 1 → a single job badge, >1 → a stack. */
  count: number;
  /** Single job: its id. Stack: "" (ids are in `job_ids`). */
  job_id: string;
  /** JSON array of job ids (MapLibre feature properties are flat). */
  job_ids: string;
  workplace_type: string;
  /** Single job whose point is inferred (company's only office in the city). */
  inferred: boolean;
}

const key = (c: number[]) => `${c[0]!.toFixed(6)},${c[1]!.toFixed(6)}`;

export function groupByLocation(
  features: GeoJSON.Feature[],
): GeoJSON.FeatureCollection<GeoJSON.Point, LocationProps> {
  const byKey = new Map<
    string,
    { coords: [number, number]; ids: string[]; types: Set<string>; inferred: boolean }
  >();
  for (const f of features) {
    if (f.geometry?.type !== "Point") continue;
    const p = f.properties as JobPointProps | null;
    if (!p?.job_id) continue;
    const coords = f.geometry.coordinates as [number, number];
    const k = key(coords);
    const entry = byKey.get(k) ?? { coords, ids: [], types: new Set<string>(), inferred: true };
    if (!entry.ids.includes(String(p.job_id))) entry.ids.push(String(p.job_id));
    entry.types.add(p.workplace_type);
    entry.inferred = entry.inferred && p.inferred === true;
    byKey.set(k, entry);
  }
  return {
    type: "FeatureCollection",
    features: [...byKey.entries()].map(([k, e]) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: e.coords },
      properties: {
        loc_id: k,
        count: e.ids.length,
        job_id: e.ids.length === 1 ? e.ids[0]! : "",
        job_ids: JSON.stringify(e.ids),
        workplace_type: e.types.size === 1 ? [...e.types][0]! : "mixed",
        inferred: e.ids.length === 1 && e.inferred,
      },
    })),
  };
}

/** Coordinates of a job on the current map, if it has one. */
export function jobCoordinates(features: GeoJSON.Feature[], jobId: string): [number, number] | null {
  for (const f of features) {
    if (f.geometry?.type === "Point" && (f.properties as JobPointProps | null)?.job_id === jobId) {
      return f.geometry.coordinates as [number, number];
    }
  }
  return null;
}
