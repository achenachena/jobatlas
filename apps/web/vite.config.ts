import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), {
    name: "preload-atlas-renderer",
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        // Download beside the entry without waiting for React to request the chunk.
        const renderer = Object.values(context.bundle ?? {}).find(asset => asset.type === "chunk" && asset.name === "SceneView");
        return renderer ? [{ tag: "link", attrs: { rel: "modulepreload", href: `/${renderer.fileName}`, crossorigin: "" }, injectTo: "head" }] : [];
      },
    },
  }],
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
