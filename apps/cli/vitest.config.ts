import { readFileSync } from "node:fs";
import { defaultClientConditions, defaultServerConditions } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import { E2eSequencer } from "./tests/e2e-sequencer.ts";

/** E2e files that run concurrently; each stack project picks free ports and its own project id. */
const e2eWorkers = Number(process.env.SUPABASE_E2E_WORKERS || "1");
if (!Number.isSafeInteger(e2eWorkers) || e2eWorkers < 1) {
  throw new Error(
    `SUPABASE_E2E_WORKERS must be a positive integer, got "${process.env.SUPABASE_E2E_WORKERS}"`,
  );
}

/**
 * E2e files that run alone: `start.health` tags a broken image under the tag every stack's
 * Mailpit resolves to, and the rest provision pg-delta shadow databases on host ports the CLI
 * picks and releases before Docker binds them, which a concurrent stack could take.
 */
const E2E_EXCLUSIVE_FILES = [
  "src/commands/start/start.health.e2e.test.ts",
  "src/command-internal/db-bootstrap/shadow-cache.e2e.test.ts",
  "src/commands/db/diff/diff.e2e.test.ts",
  "src/commands/db/diff/diff.declarative.e2e.test.ts",
  "src/commands/db/pull/pull.e2e.test.ts",
  "src/commands/db/schema/declarative/sync/sync.e2e.test.ts",
  "src/commands/db/schema/declarative/sync/sync.jobs.e2e.test.ts",
  "src/commands/db/start/start.roles.e2e.test.ts",
];

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
// and loads the built `dist/*.js`, which can be stale or missing.
const workspacePackageResolve = { conditions: [...defaultClientConditions, "bun"] };
const workspacePackageSsrResolve = { conditions: [...defaultServerConditions, "bun"] };

export default defineConfig({
  resolve: workspacePackageResolve,
  ssr: { resolve: workspacePackageSsrResolve },
  plugins: [dockerfileTextPlugin()],
  test: {
    passWithNoTests: true,
    // Vitest reads `sequence.sequencer` from the root config only; the sequencer
    // itself applies duration-aware sharding to the e2e project alone.
    sequence: { sequencer: E2eSequencer },
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
        test: {
          name: "unit",
          include: ["**/*.unit.test.ts"],
          env: { FORCE_COLOR: "1" },
        },
      },
      {
        test: {
          name: "integration",
          hookTimeout: 120_000,
          include: ["**/*.integration.test.ts"],
          // Integration workers start real service processes and containers.
          maxWorkers: 4,
          sequence: { groupOrder: 1 },
          globalSetup: ["../../packages/stack/tests/docker-volume-run.ts"],
        },
      },
      {
        test: {
          name: "e2e",
          include: ["**/*.e2e.test.ts"],
          exclude: [...configDefaults.exclude, ...E2E_EXCLUSIVE_FILES],
          fileParallelism: e2eWorkers > 1,
          maxWorkers: e2eWorkers,
          setupFiles: ["tests/e2e-setup.ts"],
          globalSetup: ["../../packages/stack/tests/docker-volume-run.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          // Runs after the e2e project, one file at a time.
          name: "e2e-exclusive",
          include: E2E_EXCLUSIVE_FILES,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
          setupFiles: ["tests/e2e-setup.ts"],
          globalSetup: ["../../packages/stack/tests/docker-volume-run.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
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
