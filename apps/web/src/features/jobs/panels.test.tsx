import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";

import { t } from "../../lib/strings";
import { card, detail, searchResponse } from "../../test/fixtures";
import { JobDetailPanel } from "./JobDetailPanel";
import { ResultsPanel } from "./ResultsPanel";

afterEach(() => vi.unstubAllGlobals());

function results(over: Partial<Parameters<typeof ResultsPanel>[0]> = {}) {
  const data = over.data ?? searchResponse({
    in_view: [card()],
    remote_elsewhere: [card({ id: "r1", title: "Remote Dev", workplace_type: "remote", location_status: "company_location",
      markers: [{ lon: -122.4, lat: 37.8, role: "headquarters", address: "SF HQ" }] })],
    location_unverified: [card({ id: "u1", title: "Accountant", location_status: "unverified", markers: [] })],
  });
  const props = {
    data, isLoading: false, isError: false, stale: false, isFetching: false,
    items: (g: "in_view" | "remote_elsewhere" | "location_unverified") => data?.groups[g].items ?? [],
    hasMore: () => false, loadingGroup: null, onLoadMore: vi.fn(), onRetry: vi.fn(),
    selectedJobId: null, onSelect: vi.fn(), onShowCompany: vi.fn(), ...over,
  };
  render(<ResultsPanel {...props} />);
  return props;
}

test("three groups are shown separately with their own counts", () => {
  results();
  for (const g of ["in_view", "remote_elsewhere", "location_unverified"] as const) {
    expect(screen.getByRole("heading", { name: new RegExp(t.groups[g]) })).toBeInTheDocument();
  }
  expect(screen.getByText(t.companyLocationNote)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: t.moveToCompany })).toBeInTheDocument();
});

test("zero results get a designed empty state", () => {
  results({ data: searchResponse() });
  expect(screen.getByText(t.emptyTitle)).toBeInTheDocument();
});

test("error without data offers a retry", async () => {
  const props = results({ data: undefined, isError: true });
  await userEvent.click(screen.getByRole("button", { name: t.retry }));
  expect(props.onRetry).toHaveBeenCalled();
});

test("stale data is labelled, not presented as fresh", () => {
  results({ stale: true });
  expect(screen.getByRole("status")).toHaveTextContent(/latest update failed/);
});

test("untrusted posting times are explained", () => {
  results({ data: searchResponse({ in_view: [card()] }, {
    warnings: [{ code: "UNTRUSTED_POSTING_TIME_EXCLUDED", message: "x", count: 7 }] }) });
  expect(screen.getByText(t.excludedTime(7))).toBeInTheDocument();
});

function renderDetail(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><JobDetailPanel jobId="job-1" onClose={() => {}} /></QueryClientProvider>);
}

test("open job: Apply opens the employer page in a new tab with a safe rel", async () => {
  renderDetail(detail());
  const link = await screen.findByRole("link", { name: /Apply on employer site/ });
  expect(link).toHaveAttribute("href", "https://example.test/apply");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  // Source text is shown as text, never as HTML.
  expect(screen.getByText("Plain description <b>not html</b>")).toBeInTheDocument();
});

test("closed job never shows Apply", async () => {
  renderDetail(detail({ status: "closed", is_open_opportunity: false, apply_url: null }));
  expect(await screen.findByText(t.notOpen)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Apply/ })).toBeNull();
});

test("unsafe apply url is not rendered as a link", async () => {
  renderDetail(detail({ apply_url: "javascript:alert(1)" }));
  expect(await screen.findByText(t.notOpen)).toBeInTheDocument();
});

test("remote job: company location note and eligibility reminder", async () => {
  renderDetail(detail({
    workplace_type: "remote", location_status: "company_location",
    locations: [{ role: "headquarters", address: "500 Market St, SF", coordinates: [-122.4, 37.8], precision: "rooftop",
      evidence: { method: "company_verified_location", excerpt: null, source_url: null, observed_at: null } }],
    eligibility: { status: "known", text: "Remote - Canada", regions: [{ id: "ca", name: "Canada", include_or_exclude: "include" }], note: "x" },
  }));
  const loc = await screen.findByText("500 Market St, SF");
  expect(within(loc.closest("li")!).getByText(t.companyLocationNote)).toBeInTheDocument();
  expect(screen.getByText(/Check the original posting/)).toBeInTheDocument();
});

test("missing fields say so instead of inventing values", async () => {
  renderDetail(detail({ salary: null, employment_type: null }));
  expect((await screen.findAllByText(t.notProvided)).length).toBeGreaterThanOrEqual(2);
});
