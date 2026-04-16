import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ["**/*.e2e.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    globalSetup: ["tests/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
