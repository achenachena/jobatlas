/** Typed client for /api/v2/atlas (types generated from the backend OpenAPI document).
 * The client never relabels a response: data_mode comes from the server, and a failed real
 * request is an error, never a fallback to demo data. */
import type { components } from "@api/schema";

import { API_BASE_URL, ApiError } from "../lib/api";

export type Capabilities = components["schemas"]["Capabilities"];
export type CitiesResponse = components["schemas"]["CitiesResponse"];
export type City = components["schemas"]["City"];
export type FrameResponse = components["schemas"]["FrameResponse"];
export type TimelineResponse = components["schemas"]["TimelineResponse"];
export type TimelineFrame = components["schemas"]["TimelineFrame"];
export type SeriesResponse = components["schemas"]["SeriesResponse"];
export type VersionResponse = components["schemas"]["VersionResponse"];
export type SourcesResponse = components["schemas"]["SourcesResponse"];
export type Quality = components["schemas"]["CityCount"]["quality"];

export type Dataset = "real" | "demo";
export type WindowKey = "1d" | "7d" | "30d";

export async function atlasGet<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/v2/atlas${path}?${q}`, { signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("Network error", 0, "NETWORK", null);
  }
  if (!res.ok) {
    let code: string | null = null;
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      code = body?.error?.code ?? body?.detail?.code ?? null;
      message = body?.error?.message ?? body?.detail?.message ?? message;
    } catch {
      /* not json */
    }
    throw new ApiError(message, res.status, code, res.headers.get("x-request-id"));
  }
  return (await res.json()) as T;
}
