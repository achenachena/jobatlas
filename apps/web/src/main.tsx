import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Base styles first, so component styles (loaded with App) win ties.
import "./styles/tokens.css";
import "./styles/global.css";

import { AtlasApp } from "./atlas/AtlasApp";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {window.location.pathname === "/" ? <AtlasApp /> : <main><h1>Page not found</h1><a href="/">Open JobAtlas</a></main>}
    </QueryClientProvider>
  </StrictMode>,
);
