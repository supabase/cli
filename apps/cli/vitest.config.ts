import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

function dockerfileTextPlugin() {
  return {
    name: "dockerfile-text-loader",
    load(id: string) {
      const [filePath] = id.split("?", 2);
      if (filePath?.endsWith("/Dockerfile") !== true) {
        return undefined;
      }

      return `export default ${JSON.stringify(readFileSync(filePath, "utf8"))};`;
    },
  };
}

export default defineConfig({
  plugins: [dockerfileTextPlugin()],
  test: {
    passWithNoTests: true,
    coverage: {
      enabled: false,
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      exclude: [
        "tests/**",
        "scripts/**",
        "**/*.unit.test.ts",
        "**/*.integration.test.ts",
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
        plugins: [dockerfileTextPlugin()],
        test: {
          name: "unit",
          include: ["**/*.unit.test.ts"],
        },
      },
      {
        plugins: [dockerfileTextPlugin()],
        test: {
          name: "integration",
          include: ["**/*.integration.test.ts"],
        },
      },
      {
        plugins: [dockerfileTextPlugin()],
        test: {
          name: "e2e",
          include: ["**/*.e2e.test.ts"],
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
