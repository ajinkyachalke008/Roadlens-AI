import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../../", import.meta.url));
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 120000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5175", headless: true },
  webServer: [
    {
      command: "npx vite --config frontend/vite.config.ts --port 5175",
      cwd,
      url: "http://127.0.0.1:5175",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "node tests/model/serve-production.mjs",
      cwd,
      url: "http://127.0.0.1:5176",
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
  reporter: [["list"]],
});
