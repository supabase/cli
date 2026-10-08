import { CLI_E2E_SHARDS, type E2eEntry, type StackEntry } from "./plan.ts";

/** Directory, relative to each Vitest root, where every run writes its JSON reports. */
export const RESULTS_DIR = ".flaky-results";

type Selection = { filters: string[] } | { changedSince: string };

export type RunSpec =
  | { suite: "unit" | "integration"; filters: string[] }
  | { suite: "focused"; repeats: number; selection: Selection }
  | ({ suite: "e2e" } & Pick<E2eEntry, "target" | "shard">)
  | ({ suite: "stack-e2e" } & Pick<StackEntry, "runtime" | "scenario">);

/** Each report name must be unique within a package, since all of them land in its `RESULTS_DIR`. */
function report(name: string): string[] {
  return ["--reporter=default", "--reporter=json", `--outputFile.json=${RESULTS_DIR}/${name}.json`];
}

function unit(extra: string[]): string[][] {
  return [["pnpm", "run", "test:unit", ...report("unit"), "--passWithNoTests", ...extra]];
}

// @supabase/api chains a Node and a Bun Vitest run in one script, and Turbo forwards arguments
// only to the last command, so its two projects run separately with their own reports.
function integration(extra: string[]): string[][] {
  const vitest = (runtime: string[], project: string, name: string) => [
    "pnpm",
    "--dir",
    "packages/api",
    "exec",
    ...runtime,
    "vitest",
    "run",
    "--project",
    project,
    ...report(name),
    "--passWithNoTests",
    ...extra,
  ];
  return [
    [
      "pnpm",
      "exec",
      "turbo",
      "run",
      "test:integration:run",
      "--continue=always",
      "--filter=!@supabase/api",
      "--",
      ...report("integration"),
      "--passWithNoTests",
      ...extra,
    ],
    vitest([], "integration", "integration-node"),
    vitest(["bun", "--bun"], "bun-integration", "integration-bun"),
  ];
}

function stackE2e(file: string): string[] {
  return [
    "pnpm",
    "--filter",
    "@supabase/stack",
    "test:e2e:run",
    `src/${file}.e2e.test.ts`,
    "--passWithNoTests=false",
    ...report(file),
  ];
}

/** The commands a matrix job runs, in order; every one runs even when an earlier one fails. */
export function commandsFor(spec: RunSpec): string[][] {
  switch (spec.suite) {
    case "unit":
      return unit(spec.filters);
    case "integration":
      return integration(spec.filters);
    case "focused": {
      const select =
        "filters" in spec.selection
          ? spec.selection.filters
          : ["--changed", spec.selection.changedSince];
      const extra = [`--repeats=${spec.repeats}`, ...select];
      return [...unit(extra), ...integration(extra)];
    }
    case "e2e":
      return spec.target === "cli"
        ? [
            [
              "pnpm",
              "exec",
              "turbo",
              "run",
              "test:e2e:run",
              "--only",
              "--filter=supabase",
              "--",
              ...report("e2e"),
              `--shard=${spec.shard}/${CLI_E2E_SHARDS}`,
            ],
          ]
        : [
            [
              "pnpm",
              "exec",
              "turbo",
              "run",
              "test:e2e:run",
              "--only",
              "--filter=@supabase/cli-e2e",
              "--",
              ...report("e2e"),
            ],
          ];
    case "stack-e2e": {
      const commands = [stackE2e(`whole-stack.${spec.runtime}.${spec.scenario}`)];
      // test.yml runs the public API suite only in this combination.
      if (spec.runtime === "native" && spec.scenario === "lifecycle") {
        commands.push(stackE2e("public"));
      }
      return commands;
    }
  }
}
