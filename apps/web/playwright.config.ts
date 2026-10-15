import { defineConfig, devices } from "@playwright/test";

/** Atlas E2E runs against Vite with deterministic API fixtures. */
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
    { name: "atlas-mobile", use: { ...devices["Pixel 7"] }, testMatch: /atlas-mobile/ },
  ],
  webServer: {
    command: "npx vite --port 5174 --strictPort",
    url: "http://localhost:5174",
    reuseExistingServer: true,
    env: { VITE_API_BASE_URL: "http://api.fixture", VITE_ATLAS_POLL_MS: "1500" },
  },
});
