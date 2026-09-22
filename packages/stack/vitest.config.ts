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
          name: "unit",
          include: ["**/*.unit.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["**/*.integration.test.ts"],
          hookTimeout: 120_000,
          testTimeout: 30_000,
          // Integration workers start real service processes and containers.
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: "e2e",
          hookTimeout: 120_000,
          include: ["**/*.e2e.test.ts"],
        },
      },
    ],
  },
});
