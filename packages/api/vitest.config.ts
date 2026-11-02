import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      enabled: false,
      provider: "v8",
      clean: false,
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
    projects: [
      {
        test: {
          name: "integration",
          include: ["**/*.integration.test.ts"],
          exclude: ["**/bun-lifecycle.integration.test.ts"],
        },
      },
      { test: { name: "bun-integration", include: ["**/bun-lifecycle.integration.test.ts"] } },
      {
        test: {
          name: "unit",
          include: ["**/*.unit.test.ts"],
        },
      },
    ],
  },
});
