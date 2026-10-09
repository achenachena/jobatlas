/** Typed client for the public, read-only JobAtlas API. Types are generated from the backend's
 * OpenAPI document (packages/api-client). Only public configuration reaches the browser. */
import type { components } from "@api/schema";

export type SearchResponse = components["schemas"]["SearchResponse"];
export type SearchPage = components["schemas"]["SearchPage"];
export type JobCard = components["schemas"]["JobCard"];
export type JobDetail = components["schemas"]["JobDetail"];
export type Region = components["schemas"]["Region"];
export type Coverage = components["schemas"]["Coverage"];
export type Workplace = JobCard["workplace_type"];
export type GroupName = SearchPage["group"];
export type TimeWindow = "all" | "today" | "24h" | "2d" | "3d" | "7d" | "30d";
export type WorkplaceFilter = "all" | "on_site" | "hybrid" | "remote";

export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8010";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly requestId: string | null,
  ) {
    super(message);
  }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/v1${path}`, { signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("Network error", 0, "NETWORK", null);
  }
  if (!res.ok) {
    let code: string | null = null;
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? null;
      message = body.error?.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status, code, res.headers.get("x-request-id"));
  }
  return (await res.json()) as T;
}

export type Bbox = [number, number, number, number];

export interface SearchParams {
  q: string;
  regionId: string;
  bbox: Bbox | null;
  timeWindow: TimeWindow;
  workplace: WorkplaceFilter;
  zoom: number | null;
}

export function searchPath(p: SearchParams, limit = 30): string {
  const qs = new URLSearchParams({
    region_id: p.regionId,
    time_window: p.timeWindow,
    workplace: p.workplace,
    limit: String(limit),
  });
  if (p.q.trim()) qs.set("q", p.q.trim().slice(0, 100));
  if (p.bbox) qs.set("bbox", p.bbox.map((v) => v.toFixed(5)).join(","));
  if (p.zoom != null) qs.set("zoom", p.zoom.toFixed(1));
  return `/search?${qs.toString()}`;
}

export type Readiness = { status: "ok" | "unavailable"; checks: Record<string, string> };
