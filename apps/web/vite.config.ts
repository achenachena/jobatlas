import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@api": fileURLToPath(new URL("../../packages/api-client", import.meta.url)) },
  },
  server: { port: 5173, fs: { allow: ["..", "../../packages"] } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    exclude: ["e2e/**", "node_modules/**"],
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
});
