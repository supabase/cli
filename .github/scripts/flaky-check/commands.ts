import { CLI_E2E_SHARDS, type E2eEntry, type StackEntry } from "./plan.ts";

/** Directory, relative to each Vitest root, where every run writes its JSON reports. */
export const RESULTS_DIR = ".flaky-results";

type Selection = { filters: string[] } | { changedSince: string };

export type RunSpec =
  | { suite: "unit" | "integration"; filters: string[] }
  | { suite: "focused"; selection: Selection }
  | ({ suite: "e2e" } & Pick<E2eEntry, "target" | "shard">)
  | ({ suite: "stack-e2e" } & Pick<StackEntry, "runtime" | "scenario">);

/**
 * Where an invocation's report lands: one package directory, or every package that runs a Turbo
 * task (`turbo` holds the task and its filters, resolved with `turbo run --dry=json`).
 */
export type ReportSource = { report: string } & ({ dir: string } | { turbo: string[] });

export type Invocation = { argv: string[]; reports: ReportSource };

/** The name a collected report gets: `apps/cli` + `unit.1` becomes `apps__cli--unit.1.json`. */
export function collectedName(dir: string, report: string): string {
  return `${dir.replaceAll("/", "__")}--${report}.json`;
}

function reporter(report: string): string[] {
  return [
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${RESULTS_DIR}/${report}.json`,
  ];
}

function turbo(task: string[], report: string, extra: string[]): Invocation {
  return {
    argv: [
      "pnpm",
      "exec",
      "turbo",
      "run",
      ...task,
      "--continue=always",
      "--",
      ...reporter(report),
      ...extra,
    ],
    reports: { turbo: task, report },
  };
}

function unit(iteration: number, extra: string[]): Invocation[] {
  return [
    turbo(["test:unit:run", "--filter=!@supabase/cli-go"], `unit.${iteration}`, [
      "--passWithNoTests",
      ...extra,
    ]),
  ];
}

// @supabase/api chains a Node and a Bun Vitest run in one script, and Turbo forwards arguments
// only to the last command, so its two projects run separately with their own reports.
function integration(iteration: number, extra: string[]): Invocation[] {
  const api = (runtime: string[], project: string, name: string): Invocation => {
    const report = `${name}.${iteration}`;
    return {
      argv: [
        "pnpm",
        "--dir",
        "packages/api",
        "exec",
        ...runtime,
        "vitest",
        "run",
        "--project",
        project,
        ...reporter(report),
        "--passWithNoTests",
        ...extra,
      ],
      reports: { dir: "packages/api", report },
    };
  };
  return [
    turbo(["test:integration:run", "--filter=!@supabase/api"], `integration.${iteration}`, [
      "--passWithNoTests",
      ...extra,
    ]),
    api([], "integration", "integration-node"),
    api(["bun", "--bun"], "bun-integration", "integration-bun"),
  ];
}

function stackE2e(file: string): Invocation {
  const report = `${file}.1`;
  return {
    argv: [
      "pnpm",
      "--filter",
      "@supabase/stack",
      "test:e2e:run",
      `src/${file}.e2e.test.ts`,
      "--passWithNoTests=false",
      ...reporter(report),
    ],
    reports: { dir: "packages/stack", report },
  };
}

/**
 * The invocations of one execution of a matrix job, in order; every one runs even when an earlier
 * one fails. Focused jobs call this once per iteration, so each execution is a fresh Vitest process.
 */
export function commandsFor(spec: RunSpec, iteration = 1): Invocation[] {
  switch (spec.suite) {
    case "unit":
      return unit(iteration, spec.filters);
    case "integration":
      return integration(iteration, spec.filters);
    case "focused": {
      const select =
        "filters" in spec.selection
          ? spec.selection.filters
          : ["--changed", spec.selection.changedSince];
      return [...unit(iteration, select), ...integration(iteration, select)];
    }
    case "e2e":
      return spec.target === "cli"
        ? [
            turbo(["test:e2e:run", "--only", "--filter=supabase"], "e2e.1", [
              `--shard=${spec.shard}/${CLI_E2E_SHARDS}`,
            ]),
          ]
        : [turbo(["test:e2e:run", "--only", "--filter=@supabase/cli-e2e"], "e2e.1", [])];
    case "stack-e2e": {
      const invocations = [stackE2e(`whole-stack.${spec.runtime}.${spec.scenario}`)];
      // test.yml runs the public API suite only in this combination.
      if (spec.runtime === "native" && spec.scenario === "lifecycle") {
        invocations.push(stackE2e("public"));
      }
      return invocations;
    }
  }
}
