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

// Workspace packages such as @supabase/config publish a `bun` export
// condition pointing at their TypeScript source (see
// packages/config/package.json's `exports` map); without it, Vite's resolver
// falls through to the `default` condition and loads the built `dist/*.js`
// output instead — which is stale, or missing entirely on a fresh clone
// before the package has been built. Extending (not replacing) Vite's
// default condition lists keeps every other package's exports resolution
// unchanged. Required on every inline `test.projects` entry below too:
// Vitest builds a separate Vite config per project and does not inherit
// these from the root config (see PR #6366 finding 0).
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
          // Stackless e2e: black-box CLI subprocesses against an isolated
          // temporary home. Safe under file-level parallelism (see the flake
          // policy in AGENTS.md), so Vitest's default parallelism applies.
          name: "e2e",
          include: ["**/*.e2e.test.ts"],
          exclude: ["**/*.stack.e2e.test.ts", "**/node_modules/**"],
          globalSetup: ["tests/e2e-global-setup.ts"],
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
          // Stack-backed e2e: files that start a local Supabase stack or run
          // Docker containers claim machine-level resources, so they run one
          // file at a time. Vitest schedules this serial group after the
          // parallel projects finish. Opt in with the `*.stack.e2e.test.ts`
          // suffix (ADR 0024).
          name: "e2e-stack",
          include: ["**/*.stack.e2e.test.ts"],
          fileParallelism: false,
          maxWorkers: 1,
          globalSetup: ["tests/e2e-global-setup.ts"],
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
