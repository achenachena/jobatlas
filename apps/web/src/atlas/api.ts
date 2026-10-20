/** Typed client for /api/v2/atlas (types generated from the backend OpenAPI document).
 * The client never relabels a response: data_mode comes from the server, and a failed real
 * request is an error, never a fallback to demo data. */
import type { components } from "@api/schema";

import { API_BASE_URL, ApiError } from "../lib/api";

export type Capabilities = components["schemas"]["Capabilities"];
export type CitiesResponse = components["schemas"]["CitiesResponse"];
export type City = components["schemas"]["City"];
export type Group = components["schemas"]["Group"];
export type FrameResponse = components["schemas"]["FrameResponse"];
export type TimelineResponse = components["schemas"]["TimelineResponse"];
export type SeriesResponse = components["schemas"]["SeriesResponse"];
export type VersionResponse = components["schemas"]["VersionResponse"];
export type SourcesResponse = components["schemas"]["SourcesResponse"];

export type Gap = components["schemas"]["Gap"];

/** Job Bank ("real") and Employer boards ("ats") are parallel datasets: never summed or shown
 * together. "demo" is generated data. */
export type Dataset = "real" | "ats" | "demo";
export const DATASET_NAME: Record<Dataset, string> = { real: "Job Bank", ats: "Employer boards", demo: "Demo" };
export type WindowKey = "1d" | "7d" | "30d";

export async function atlasGet<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
  cache?: Cache,
  validate?: (value: T) => void,
): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const url = `${API_BASE_URL}/api/v2/atlas${path}?${q}`;
  signal?.throwIfAborted();
  const saved = cache ? await cache.match(url).catch(() => undefined) : undefined;
  if (saved) {
    try {
      const value = await saved.json() as T;
      validate?.(value);
      signal?.throwIfAborted();
      return value;
    } catch {
      signal?.throwIfAborted();
      await cache?.delete(url).catch(() => false);
    }
  }
  let res: Response;
  try {
    res = await fetch(url, { signal });
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
  // Only the release-pinned replay loader supplies a cache. Stream a response clone
  // to browser storage without serializing the large parsed matrix on the UI thread.
  const copy = cache ? res.clone() : undefined;
  const value = await res.json() as T;
  validate?.(value);
  signal?.throwIfAborted();
  if (cache && copy) await cache.put(url, copy).catch(() => {});
  return value;
}
