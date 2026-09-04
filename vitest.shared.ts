import { defaultClientConditions, defaultServerConditions } from "vite";
import {
  defineConfig,
  mergeConfig,
  type TestProjectInlineConfiguration,
  type ViteUserConfig,
} from "vitest/config";

/**
 * Shared Vitest preset for every TypeScript workspace.
 *
 * Package configs play two roles: `bun --bun vitest` inside a package treats the
 * package config as the root, while the repo-root `vitest.config.mts` loads the
 * same file as a nested project group. Vitest only inherits options into
 * *inline* projects, never into config files referenced by glob, so anything
 * shared across packages has to be merged in here rather than declared once at
 * the root.
 */

/** Test kinds and the colocated file suffix each one owns (see CLAUDE.md, "Testing"). */
const testKinds = {
  unit: "**/*.unit.test.ts",
  integration: "**/*.integration.test.ts",
  e2e: "**/*.e2e.test.ts",
  live: "**/*.live.test.ts",
} as const;

export type TestKind = keyof typeof testKinds;

/**
 * One inline project per test kind. Nested under a package config, Vitest names
 * it `<package name> (<kind>)`, so `vitest --project '*(unit)'` from the root
 * selects that kind across the whole repo. Project-level overrides (timeouts,
 * setup files, parallelism) layer on top.
 */
export function testProject(
  kind: TestKind,
  overrides: TestProjectInlineConfiguration = {},
): TestProjectInlineConfiguration {
  return {
    ...overrides,
    test: { ...overrides.test, name: kind, include: [testKinds[kind]] },
  };
}

/**
 * Run-level options that Vitest applies only from the root config of a run.
 * Set on the repo-root config and on every package config (for standalone runs).
 */
export const runDefaults = {
  passWithNoTests: true,
  // Console output from passing tests is noise; failing tests still print theirs.
  silent: "passed-only",
} as const;

const packageDefaults: ViteUserConfig = defineConfig({
  // Workspace packages such as @supabase/config, @supabase/stack, and
  // @supabase/api publish a `bun` export condition pointing at their TypeScript
  // source. Without it Vite falls through to the `default` condition and loads
  // built `dist/*.js` output, which is stale or missing on a fresh clone.
  // Extending (not replacing) Vite's default condition lists leaves every other
  // package's exports resolution unchanged. Vitest 5 inherits these into the
  // inline projects declared below each package config.
  resolve: { conditions: [...defaultClientConditions, "bun"] },
  ssr: { resolve: { conditions: [...defaultServerConditions, "bun"] } },
  test: {
    ...runDefaults,
    // Coverage is a run-level option too, so this only applies to standalone
    // package runs (`pnpm test:unit --coverage.enabled`). Each package's
    // `test:*:run` script points `reportsDirectory` at a per-kind subdirectory.
    coverage: {
      enabled: false,
      provider: "istanbul",
      clean: false,
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});

/** A package's Vitest config: the shared preset with package-specific options merged on top. */
export function definePackageConfig(config: ViteUserConfig): ViteUserConfig {
  return mergeConfig(packageDefaults, config);
}
