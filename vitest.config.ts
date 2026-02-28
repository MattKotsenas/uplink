import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["test/e2e/**"],
    testTimeout: 15000,
    passWithNoTests: true,
    environmentMatchGlobs: [
      ["test/component/**", "jsdom"],
    ],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/mock/**"],
      reporter: ["text", "text-summary"],
    },
  },
});
