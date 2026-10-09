import { groupByLocation, jobCoordinates } from "./locations";

const pt = (job_id: string, lon: number, lat: number, workplace_type = "hybrid"): GeoJSON.Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { job_id, workplace_type, location_role: "work_site" },
});

test("jobs at the exact same coordinate become one stack; others stay single", () => {
  const fc = groupByLocation([
    pt("a", -79.38, 43.65),
    pt("b", -79.38, 43.65, "on_site"),
    pt("c", -79.38, 43.65),
    pt("d", -79.39, 43.66, "remote"),
  ]);
  expect(fc.features).toHaveLength(2);
  const stack = fc.features.find((f) => f.properties.count === 3)!;
  expect(JSON.parse(stack.properties.job_ids)).toEqual(["a", "b", "c"]);
  expect(stack.properties.workplace_type).toBe("mixed");
  // never offset: the stack sits on the real point
  expect(stack.geometry.coordinates).toEqual([-79.38, 43.65]);
  const single = fc.features.find((f) => f.properties.count === 1)!;
  expect(single.properties).toMatchObject({ job_id: "d", workplace_type: "remote" });
});

test("a job with several markers at one place is counted once", () => {
  const fc = groupByLocation([pt("a", -79.38, 43.65), pt("a", -79.38, 43.65)]);
  expect(fc.features[0]!.properties.count).toBe(1);
});

test("jobCoordinates finds a job's point or reports none", () => {
  const fs = [pt("a", -79.38, 43.65)];
  expect(jobCoordinates(fs, "a")).toEqual([-79.38, 43.65]);
  expect(jobCoordinates(fs, "zzz")).toBeNull();
});
