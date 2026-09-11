import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 180000,
  expect: { timeout: 20000 },
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:10006",
    headless: true,
    viewport: { width: 390, height: 844 },
    trace: "off",
    screenshot: "off",
  },
  reporter: [["list"]],
});
