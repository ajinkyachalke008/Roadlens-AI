import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve("frontend"),
  plugins: [react()],
  worker: { format: "es" },
  // Worker-only imports evade the initial crawl; late optimization would reload
  // the camera page and correctly erase its RAM session on first use.
  optimizeDeps: { include: ["onnxruntime-web/wasm"] },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:10000",
      "/healthz": "http://127.0.0.1:10000",
      "/ws": { target: "ws://127.0.0.1:10000", ws: true },
    },
  },
  build: { target: "es2022", outDir: "dist" },
});
