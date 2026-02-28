import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  test: {
    testTimeout: 15000,
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/mock/**"],
      reporter: ["text", "text-summary"],
    },
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
        },
      },
      {
        plugins: [preact()],
        test: {
          name: "component",
          environment: "jsdom",
          include: ["test/component/**/*.test.tsx"],
          pool: "threads",
        },
      },
    ],
  },
});
