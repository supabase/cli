import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      exclude: [
        "tests/**",
        "scripts/**",
        "**/*.test.ts",
        "**/*.e2e.test.ts",
        "**/*.command.ts",
        "src/app.ts",
        "src/bin.ts",
        "src/index.ts",
        "src/supabase.ts",
      ],
    },
    projects: [
      {
        test: {
          name: "core",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.e2e.test.ts"],
        },
      },
      {
        test: {
          name: "e2e",
          include: ["src/**/*.e2e.test.ts"],
          fileParallelism: false,
          maxWorkers: 1,
          globalSetup: ["tests/e2e-global-setup.ts"],
          setupFiles: ["tests/e2e-setup.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
