import { postedText, relativeTime, safeHttpUrl, salaryText } from "./format";
import { t } from "./strings";

test("relativeTime never invents a time", () => {
  expect(relativeTime(null)).toBeNull();
  expect(relativeTime("not a date")).toBeNull();
  const now = Date.parse("2026-10-09T12:00:00Z");
  expect(relativeTime("2026-10-09T09:00:00Z", now)).toBe("3 hours ago");
});

test("postedText distinguishes posting-time quality", () => {
  expect(postedText({ posted_at: null, posted_date: null, posted_basis: "republished_only", posted_precision: "none" })).toBe(t.republishedOnly);
  expect(postedText({ posted_at: null, posted_date: null, posted_basis: "unknown", posted_precision: "none" })).toBe(t.postedUnknown);
  expect(postedText({ posted_at: null, posted_date: "2026-10-07", posted_basis: "original", posted_precision: "date" })).toBe("Posted Oct 7, 2026");
  // New in a complete listing: shown as when we first spotted it, never as a posting time.
  const now = new Date(Date.now() - 2 * 3600_000).toISOString();
  const listed = { posted_at: null, posted_date: null, posted_precision: "none", listed_after: now, first_seen_at: now } as const;
  expect(postedText({ ...listed, posted_basis: "republished_only" })).toBe(t.newListing("2 hours ago"));
  expect(postedText({ ...listed, posted_basis: "original", posted_precision: "date", posted_date: "2026-10-07" })).toBe("Posted Oct 7, 2026");
});

test("salaryText keeps periods and raw text, never estimates", () => {
  expect(salaryText(null)).toBeNull();
  expect(salaryText({ min: 110000, max: 135000, currency: "CAD", period: "year", raw_text: null })).toMatch(/110,000.*135,000 \/ year/);
  expect(salaryText({ min: null, max: null, currency: null, period: null, raw_text: "$20/hr" })).toBe("$20/hr");
});

test("safeHttpUrl only allows http(s)", () => {
  expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
  expect(safeHttpUrl("data:text/html,x")).toBeNull();
  expect(safeHttpUrl("https://jobs.example/1")).toBe("https://jobs.example/1");
});
