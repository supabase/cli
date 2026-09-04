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
          testTimeout: 60_000,
        },
      },
      {
        test: {
          // Every e2e file here starts a local stack, so the whole kind is
          // stack-backed and serial. See ADR 0024 for the `*.stack.e2e.test.ts`
          // convention.
          name: "e2e-stack",
          include: ["**/*.stack.e2e.test.ts"],
          fileParallelism: false,
          globalSetup: ["./tests/global-setup.ts"],
        },
      },
    ],
  },
});
