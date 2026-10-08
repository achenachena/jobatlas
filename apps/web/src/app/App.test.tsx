import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { App } from "./App";

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

test("shows backend readiness from the API", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ status: "ok", checks: {} }), { status: 200 })),
  );
  renderApp();
  expect(await screen.findByText("Backend ready")).toBeInTheDocument();
});

test("reports an unavailable backend instead of pretending", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
  renderApp();
  expect(await screen.findByText("Backend unavailable")).toBeInTheDocument();
});
