import { afterEach, expect, it, vi } from "vitest";
import { atlasGet } from "./api";
afterEach(() => vi.unstubAllGlobals());
function memoryCache() {
  const data = new Map<string, Response>();
  return {
    match: vi.fn(async (url: string) => data.get(url)?.clone()),
    put: vi.fn(async (url: string, response: Response) => { data.set(url, response); }),
    delete: vi.fn(async (url: string) => data.delete(url)),
  } as unknown as Cache;
}
it("reuses validated pinned responses without another request", async () => {
  const cache = memoryCache();
  const fetcher = vi.fn(async () => Response.json({ release: "r1", national: 42 }));
  vi.stubGlobal("fetch", fetcher);
  const validate = (value: {release: string}) => { if (value.release !== "r1") throw new Error("wrong release"); };
  await atlasGet("/timeline", {release:"r1"}, undefined, cache, validate);
  expect(await atlasGet("/timeline", {release:"r1"}, undefined, cache, validate)).toEqual({release:"r1",national:42});
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("invalid cached data is discarded and failed responses are never saved", async () => {
  const cache = memoryCache();
  vi.mocked(cache.match).mockResolvedValueOnce(Response.json({release:"wrong"}));
  const fetcher = vi.fn(async () => Response.json({release:"r1"}));
  vi.stubGlobal("fetch", fetcher);
  const validate = (value: {release: string}) => { if (value.release !== "r1") throw new Error("wrong release"); };
  await atlasGet("/timeline", {release:"r1"}, undefined, cache, validate);
  expect(cache.delete).toHaveBeenCalledTimes(1);
  fetcher.mockImplementation(async () => Response.json({error:{message:"Unavailable"}}, {status:503}));
  await expect(atlasGet("/timeline", {release:"r2"}, undefined, cache, validate)).rejects.toThrow("Unavailable");
  expect(cache.put).toHaveBeenCalledTimes(1);
});
it("storage failure falls back to the network and aborts still win", async () => {
  const cache = memoryCache();
  vi.mocked(cache.match).mockRejectedValue(new Error("Storage disabled"));
  vi.mocked(cache.put).mockRejectedValue(new Error("Quota"));
  const fetcher = vi.fn(async () => Response.json({national:42}));
  vi.stubGlobal("fetch", fetcher);
  expect(await atlasGet("/timeline", {release:"r1"}, undefined, cache)).toEqual({national:42});
  const controller = new AbortController();controller.abort();
  await expect(atlasGet("/timeline", {release:"r1"}, controller.signal, cache)).rejects.toMatchObject({name:"AbortError"});
  expect(fetcher).toHaveBeenCalledTimes(1);
});
