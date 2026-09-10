import { readFileSync } from "node:fs";
import { defaultClientConditions, defaultServerConditions } from "vite";
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

// Workspace packages such as @supabase/config publish a `bun` export condition
// pointing at their TypeScript source; without it, Vite falls through to `default`
// and loads the built `dist/*.js`, which can be stale or missing. Each inline
// `test.projects` entry below needs this too, since Vitest builds a separate Vite
// config per project and does not inherit it from the root config.
const workspacePackageResolve = { conditions: [...defaultClientConditions, "bun"] };
const workspacePackageSsrResolve = { conditions: [...defaultServerConditions, "bun"] };

export default defineConfig({
  resolve: workspacePackageResolve,
  ssr: { resolve: workspacePackageSsrResolve },
  plugins: [dockerfileTextPlugin()],
  test: {
    passWithNoTests: true,
    coverage: {
      enabled: false,
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      exclude: [
        "tests/**",
        "scripts/**",
        "**/*.unit.test.ts",
        "**/*.integration.test.ts",
        "**/*.e2e.test.ts",
        "**/*.live.test.ts",
        "**/*.command.ts",
        "src/app.ts",
        "src/bin.ts",
        "src/index.ts",
        "src/supabase.ts",
      ],
    },
    projects: [
      {
        resolve: workspacePackageResolve,
        ssr: { resolve: workspacePackageSsrResolve },
        plugins: [dockerfileTextPlugin()],
        test: {
          name: "unit",
          include: ["**/*.unit.test.ts"],
          env: { FORCE_COLOR: "1" },
        },
      },
      {
        resolve: workspacePackageResolve,
        ssr: { resolve: workspacePackageSsrResolve },
        plugins: [dockerfileTextPlugin()],
        test: {
          name: "integration",
          include: ["**/*.integration.test.ts"],
        },
      },
      {
        resolve: workspacePackageResolve,
        ssr: { resolve: workspacePackageSsrResolve },
        plugins: [dockerfileTextPlugin()],
        test: {
          name: "e2e",
          include: ["**/*.e2e.test.ts"],
          fileParallelism: false,
          maxWorkers: 1,
          setupFiles: ["tests/e2e-setup.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve: workspacePackageResolve,
        ssr: { resolve: workspacePackageSsrResolve },
        plugins: [dockerfileTextPlugin()],
        test: {
          // Live tests run against one provisioned project on the configured
          // platform. They are never part of the default unit/integration/e2e
          // loop; an explicit run fails fast when required configuration is absent.
          name: "live",
          include: ["**/*.live.test.ts"],
          fileParallelism: false,
          maxWorkers: 1,
          globalSetup: ["tests/live-global-setup.ts"],
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
