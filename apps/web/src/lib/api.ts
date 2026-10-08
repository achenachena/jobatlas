/** Public, read-only API client. Only public configuration is injected into the browser. */
export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8010";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId: string | null,
  ) {
    super(message);
  }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE_URL}/api/v1${path}`, { signal });
  if (!res.ok) {
    throw new ApiError(`GET ${path} failed`, res.status, res.headers.get("x-request-id"));
  }
  return (await res.json()) as T;
}

export type Readiness = { status: "ok" | "unavailable"; checks: Record<string, string> };
