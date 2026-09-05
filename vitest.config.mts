import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { runDefaults } from "./vitest.shared.mts";

// Every package config becomes a nested project group named after the package,
// so `vitest --project 'supabase (unit)'` or `--project '*(integration)'` selects
// slices of the whole repo from one process. Run-level options such as `silent`
// are not inherited by these file-referenced projects; they come from
// `vitest.shared.mts` through each package config for standalone runs and are
// repeated here for root runs.

const byPath = (a: TestSpecification, b: TestSpecification) => a.moduleId.localeCompare(b.moduleId);

/**
 * Deterministic, duration-blind shard balancing (ADR 0024).
 *
 * Vitest's default `shard()` sorts files by a path hash and cuts contiguous
 * slices, so the serial stack-backed e2e files land on shards by luck. This
 * sequencer deals files round-robin instead, one test project at a time with a
 * running offset, so every project splits evenly across shards: each shard gets
 * half of the CLI's integration files and half of its unit files rather than
 * all of one kind, and the stack-backed e2e projects, dealt first, spread their
 * serial files as evenly as their counts allow. Every shard computes the same
 * partition independently, so the ordering has to be stable across machines.
 *
 * `sort()` keeps Vitest's project grouping but orders files lexicographically
 * within a project, which is what the compatibility e2e suite in apps/cli-e2e
 * relies on for deterministic replay ordering.
 */
class BalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const byProject = new Map<string, TestSpecification[]>();
    for (const spec of files) {
      byProject.set(spec.project.name, [...(byProject.get(spec.project.name) ?? []), spec]);
    }
    const projects = [...byProject.keys()].sort(
      (a, b) =>
        Number(b.endsWith("(e2e-stack)")) - Number(a.endsWith("(e2e-stack)")) || a.localeCompare(b),
    );
    const selected: TestSpecification[] = [];
    let offset = 0;
    for (const name of projects) {
      const specs = [...(byProject.get(name) ?? [])].sort(byPath);
      selected.push(...specs.filter((_, position) => (position + offset) % count === index - 1));
      offset += specs.length;
    }
    return selected;
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.project.name.localeCompare(b.project.name) || byPath(a, b));
  }
}

export default defineConfig({
  test: {
    ...runDefaults,
    projects: ["apps/*/vitest.config.ts", "packages/*/vitest.config.ts"],
    sequence: { sequencer: BalancedSequencer },
    // Root runs produce one merged report across packages. Disabled by default;
    // the develop-push coverage workflow enables it. Include patterns are
    // repo-relative because Vitest 5 matches coverage globs without a
    // "contains" fallback.
    coverage: {
      enabled: false,
      provider: "v8",
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/tests/**",
        "**/scripts/**",
        "apps/cli-e2e/**",
        "apps/cli/src/**/*.command.ts",
        "apps/cli/src/app.ts",
        "apps/cli/src/bin.ts",
        "apps/cli/src/index.ts",
        "apps/cli/src/supabase.ts",
      ],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
