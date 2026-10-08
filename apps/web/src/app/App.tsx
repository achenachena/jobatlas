import { useQuery } from "@tanstack/react-query";

import { apiGet, type Readiness } from "../lib/api";
import styles from "./App.module.css";

/**
 * Stage 1 shell: proves the web app builds, talks to the API and renders design tokens.
 * The map, filters and job panels arrive in stage 3; no placeholder jobs are shown here.
 */
export function App() {
  const ready = useQuery({
    queryKey: ["health", "ready"],
    queryFn: ({ signal }) => apiGet<Readiness>("/health/ready", signal),
  });

  let status: string;
  if (ready.isPending) status = "Checking backend…";
  else if (ready.isError) status = "Backend unavailable";
  else status = ready.data.status === "ok" ? "Backend ready" : "Backend degraded";

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.brand}>JobAtlas</h1>
        <p className={styles.tagline}>Explore job opportunities on a live, interactive map.</p>
      </header>
      <section className={styles.card} aria-live="polite">
        <span
          className={styles.dot}
          data-state={ready.isError ? "error" : ready.data?.status ?? "pending"}
          aria-hidden="true"
        />
        <span>{status}</span>
      </section>
      <p className={styles.note}>Development build — the GTA map is not implemented yet.</p>
    </main>
  );
}
