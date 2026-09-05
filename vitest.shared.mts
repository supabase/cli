import { defaultClientConditions, defaultServerConditions } from "vite";
import {
  defaultExclude,
  defineConfig,
  mergeConfig,
  type TestProjectInlineConfiguration,
  type TestUserConfig,
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

const STACK_E2E_GLOB = "**/*.stack.e2e.test.ts";

/**
 * Test kinds and the colocated file suffix each one owns (see AGENTS.md,
 * "Testing"). `e2e-stack` is the sub-kind for e2e files that start a local
 * stack or run Docker containers; the plain `e2e` kind excludes them so the two
 * projects partition the e2e files (ADR 0024).
 */
export type TestKind = "unit" | "integration" | "e2e" | "e2e-stack" | "live";

const testKinds: Record<TestKind, { include: string; exclude?: string[] }> = {
  unit: { include: "**/*.unit.test.ts" },
  integration: { include: "**/*.integration.test.ts" },
  e2e: { include: "**/*.e2e.test.ts", exclude: [STACK_E2E_GLOB, ...defaultExclude] },
  "e2e-stack": { include: STACK_E2E_GLOB },
  live: { include: "**/*.live.test.ts" },
};

/**
 * One inline project per test kind. Nested under a package config, Vitest names
 * it `<package name> (<kind>)`, so `vitest --project '*(unit)'` from the root
 * selects that kind across the whole repo. Project-level overrides (timeouts,
 * setup files) layer on top.
 *
 * Stack-backed e2e files claim machine-level resources, so `e2e-stack` runs one
 * file at a time by default. Vitest schedules that serial group after the
 * parallel projects finish.
 */
export function testProject(
  kind: TestKind,
  overrides: TestProjectInlineConfiguration = {},
): TestProjectInlineConfiguration {
  const spec = testKinds[kind];
  const serial = kind === "e2e-stack" ? { fileParallelism: false, maxWorkers: 1 } : {};
  return {
    ...overrides,
    test: {
      ...serial,
      ...overrides.test,
      name: kind,
      include: [spec.include],
      ...(spec.exclude ? { exclude: spec.exclude } : {}),
    },
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
  // Persist Vite's transform output under node_modules/.vitest-cache so reruns
  // and separate processes reuse it. CI restores that directory between runs.
  fsModuleCache: true,
} as const satisfies TestUserConfig;

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
      provider: "v8",
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
