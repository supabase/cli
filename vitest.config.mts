import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
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
const isStackBacked = (spec: TestSpecification) => spec.project.name.endsWith("(e2e-stack)");

/**
 * Per-file durations from the last develop run, produced by
 * `tools/test-shard-weights.ts` and delivered to CI shards as a run artifact
 * (see `.github/workflows/develop-tests.yml` and `test.yml`). Keyed by
 * repo-relative path in seconds. Absent locally and on a cold cache.
 */
const SHARD_WEIGHTS_FILE = process.env["VITEST_SHARD_WEIGHTS"] ?? ".vitest/shard-weights.json";

function loadShardWeights(): ReadonlyMap<string, number> | undefined {
  if (!existsSync(SHARD_WEIGHTS_FILE)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(SHARD_WEIGHTS_FILE, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("weights" in parsed)) return undefined;
  const weights = (parsed as { weights: Record<string, unknown> }).weights;
  return new Map(
    Object.entries(weights).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] >= 0,
    ),
  );
}

/**
 * Deterministic shard balancing (ADR 0024).
 *
 * Vitest's default `shard()` sorts files by a path hash and cuts contiguous
 * slices, so the serial stack-backed e2e files land on shards by luck. Files
 * are balanced here in two classes, stack-backed first, then everything else,
 * because a serial file and a parallel file do not cost the same.
 *
 * With develop's per-file durations available, each class is assigned
 * largest-first to the least-loaded shard; files without a recorded duration
 * get the class median so a new file degrades balance slightly rather than
 * breaking it. Without durations, files are dealt round-robin within each
 * test project with a running offset, which still halves every project across
 * shards (sorting every file by path would pair each integration file with
 * its unit sibling and hand one shard all of one kind).
 *
 * Every shard computes the same partition independently, so both paths depend
 * only on the file list and the weights file, and every ordering is total.
 *
 * `sort()` keeps Vitest's project grouping but orders files lexicographically
 * within a project, which is what the compatibility e2e suite in apps/cli-e2e
 * relies on for deterministic replay ordering.
 */
class BalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const weights = loadShardWeights();
    const classes = [files.filter(isStackBacked), files.filter((spec) => !isStackBacked(spec))];
    const selected: TestSpecification[] = [];
    for (const specs of classes) {
      selected.push(
        ...(weights === undefined
          ? dealByProject(specs, index, count)
          : assignByWeight(specs, index, count, weights)),
      );
    }
    return selected;
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.project.name.localeCompare(b.project.name) || byPath(a, b));
  }
}

function dealByProject(specs: TestSpecification[], index: number, count: number) {
  const byProject = new Map<string, TestSpecification[]>();
  for (const spec of specs) {
    byProject.set(spec.project.name, [...(byProject.get(spec.project.name) ?? []), spec]);
  }
  const selected: TestSpecification[] = [];
  let offset = 0;
  for (const name of [...byProject.keys()].sort()) {
    const projectSpecs = [...(byProject.get(name) ?? [])].sort(byPath);
    selected.push(
      ...projectSpecs.filter((_, position) => (position + offset) % count === index - 1),
    );
    offset += projectSpecs.length;
  }
  return selected;
}

function assignByWeight(
  specs: TestSpecification[],
  index: number,
  count: number,
  weights: ReadonlyMap<string, number>,
) {
  const root = process.cwd();
  const known = specs
    .map((spec) => weights.get(relative(root, spec.moduleId)))
    .filter((weight): weight is number => weight !== undefined)
    .sort((a, b) => a - b);
  const fallback = known.length === 0 ? 1 : (known[Math.floor(known.length / 2)] ?? 1);
  const weightOf = (spec: TestSpecification) =>
    weights.get(relative(root, spec.moduleId)) ?? fallback;
  const loads = Array.from({ length: count }, () => 0);
  const selected: TestSpecification[] = [];
  for (const spec of [...specs].sort((a, b) => weightOf(b) - weightOf(a) || byPath(a, b))) {
    let target = 0;
    for (let shard = 1; shard < count; shard++) {
      if ((loads[shard] ?? 0) < (loads[target] ?? 0)) target = shard;
    }
    loads[target] = (loads[target] ?? 0) + weightOf(spec);
    if (target === index - 1) selected.push(spec);
  }
  return selected;
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
