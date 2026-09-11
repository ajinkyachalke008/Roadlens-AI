import { defineConfig } from "@playwright/test";
import { localTlsAllowed } from "./tests/e2e/localTls";
const externalBase = process.env.ROADLENS_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // Network traces can retain capability responses. Capture only explicit, code-free UI evidence below.
  use: {
    baseURL: externalBase ?? "http://127.0.0.1:5173",
    headless: true,
    ignoreHTTPSErrors: localTlsAllowed(),
    viewport: { width: 1440, height: 1000 },
    trace: "off",
    screenshot: "off",
  },
  webServer: externalBase
    ? undefined
    : {
        command:
          process.env.ROADLENS_TEST_FORCE_OPTIMIZE === "1"
            ? 'npx concurrently -k "tsx watch backend/src/main.ts" "vite --force --config frontend/vite.config.ts"'
            : "npm run dev",
        url: "http://127.0.0.1:5173",
        reuseExistingServer: false,
        timeout: 45_000,
        stdout: "pipe",
        env: { DEBUG: "vite:deps" },
      },
  reporter: [["list"]],
});
