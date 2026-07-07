import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      enabled: false,
      provider: "istanbul",
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
    ],
  },
});
