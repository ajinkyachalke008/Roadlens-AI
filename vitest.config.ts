import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 15000,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "tests/model/**"],
  },
});
