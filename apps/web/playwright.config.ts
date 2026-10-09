import { defineConfig, devices } from "@playwright/test";

/** E2E runs against the Vite dev server with the API mocked by fixture routes (deterministic).
 * The live smoke test (e2e/live.spec.ts) hits a real API and only runs with LIVE=1. */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:5174",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 860 } }, testIgnore: /mobile|live/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile/ },
    { name: "live", use: { ...devices["Desktop Chrome"] }, testMatch: /live/ },
  ],
  webServer: {
    command: "npx vite --port 5174 --strictPort",
    url: "http://localhost:5174",
    reuseExistingServer: true,
    env: { VITE_API_BASE_URL: process.env.LIVE ? "http://localhost:8010" : "http://api.fixture" },
  },
});
