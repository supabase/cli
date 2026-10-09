export const WEEKLY_CRON = "47 3 * * 0";
/** Directory, relative to each Vitest root, where every run writes its JSON reports. */
export const RESULTS_DIR = ".flaky-results";
const SUITES = ["unit", "integration", "focused", "e2e", "stack-e2e"] as const;
type Suite = (typeof SUITES)[number];
const CLI_E2E_SHARDS = 4;
// GitHub rejects a matrix with more jobs than this.
const MAX_JOBS = 256;

/** One matrix job; the workflow reads its runner, timeout, checkout depth, and Go cache. */
export type Entry = {
  name: string;
  run: number;
  /** Executions of the suite in this job, each a separate Vitest process. */
  executions: number;
  runner: string;
  timeout: number;
  fetchDepth: number;
  goCache: boolean;
} & (
  | { suite: "unit" | "integration" | "focused" }
  | { suite: "e2e"; target: "cli" | "cli-e2e"; shard: number }
  | {
      suite: "stack-e2e";
      runtime: "native" | "docker" | "podman";
      scenario: "lifecycle" | "idle-parallel";
    }
);

export type PlanInput = {
  event: string;
  schedule: string;
  baseRef: string;
  suites: string;
  runs: string;
  repeats: string;
  filter: string;
};

export class CheckError extends Error {}

function count(value: string, label: string, max: number, min = 0): number {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CheckError(
      `${label} must be a whole number between ${min} and ${max}, got '${value}'`,
    );
  }
  return parsed;
}

function parseSuites(value: string): Suite[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const unknown = names.find((name) => !SUITES.some((suite) => suite === name));
  if (unknown !== undefined) {
    throw new CheckError(`unknown suite '${unknown}'; choose from ${SUITES.join(",")}`);
  }
  const suites = SUITES.filter((suite) => names.includes(suite));
  if (suites.length === 0) {
    throw new CheckError(`no suites selected; choose from ${SUITES.join(",")}`);
  }
  return suites;
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index + 1);
}

function entriesFor(suite: Suite, run: number, repeats: number): Entry[] {
  const job = {
    run,
    executions: 1,
    runner: "blacksmith-8vcpu-ubuntu-2404",
    timeout: 30,
    fetchDepth: 1,
    goCache: false,
  };
  switch (suite) {
    case "unit":
      return [
        { ...job, suite, name: `flaky-unit-run${run}`, runner: "blacksmith-4vcpu-ubuntu-2404" },
      ];
    case "integration":
      return [{ ...job, suite, name: `flaky-integration-run${run}` }];
    case "focused":
      // A full history lets focused runs diff against the merge base.
      return [
        {
          ...job,
          suite,
          name: `flaky-focused-run${run}`,
          executions: repeats + 1,
          timeout: 60,
          fetchDepth: 0,
        },
      ];
    case "e2e": {
      const e2e = { ...job, suite, timeout: 45, fetchDepth: 0, goCache: true };
      return [
        ...range(CLI_E2E_SHARDS).map((shard) => ({
          ...e2e,
          target: "cli" as const,
          shard,
          name: `flaky-e2e-cli${shard}-run${run}`,
        })),
        { ...e2e, target: "cli-e2e", shard: 0, name: `flaky-e2e-cli-e2e-run${run}` },
      ];
    }
    case "stack-e2e":
      return (["native", "docker", "podman"] as const).flatMap((runtime) =>
        (["lifecycle", "idle-parallel"] as const).map((scenario) => ({
          ...job,
          suite,
          runtime,
          scenario,
          timeout: 45,
          name: `flaky-stack-e2e-${runtime}-${scenario}-run${run}`,
        })),
      );
  }
}

/** Matrix jobs for a trigger; `base` is the branch focused runs diff against. */
export function plan(input: PlanInput): { entries: Entry[]; base: string; filter: string } {
  let suites: Suite[] = ["unit", "integration"];
  let runs = 10;
  let repeats = 4;
  let filter = "";
  let base = "develop";
  if (input.event === "workflow_dispatch") {
    suites = parseSuites(input.suites);
    runs = count(input.runs, "runs", 30, 1);
    repeats = count(input.repeats, "repeats", 100);
    filter = input.filter.trim();
  } else if (input.event === "pull_request") {
    suites = ["unit", "integration", "focused"];
    base = input.baseRef;
  } else if (input.schedule === WEEKLY_CRON) {
    suites = ["e2e", "stack-e2e"];
    runs = 3;
  }

  const entries = suites.flatMap((suite) =>
    range(runs).flatMap((run) => entriesFor(suite, run, repeats)),
  );
  if (entries.length > MAX_JOBS) {
    throw new CheckError(
      `${entries.length} jobs exceed GitHub's ${MAX_JOBS}-job matrix limit; lower runs`,
    );
  }
  return { entries, base, filter };
}

/**
 * Where an invocation's report lands: one package directory, or every package that runs a Turbo
 * task (`turbo` holds the task and its filters, resolved with `turbo run --dry=json`).
 */
export type ReportSource = { report: string } & ({ dir: string } | { turbo: string[] });

type Invocation = { argv: string[]; reports: ReportSource };

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

function api(runtime: string[], project: string, report: string, extra: string[]): Invocation {
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
      ...extra,
    ],
    reports: { dir: "packages/api", report },
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
  const args = ["--passWithNoTests", ...extra];
  return [
    turbo(["test:integration:run", "--filter=!@supabase/api"], `integration.${iteration}`, args),
    api([], "integration", `integration-node.${iteration}`, args),
    api(["bun", "--bun"], "bun-integration", `integration-bun.${iteration}`, args),
  ];
}

/** The invocations of one execution of a job, in order; each runs even when an earlier one fails. */
export function commandsFor(entry: Entry, iteration: number, extra: string[]): Invocation[] {
  switch (entry.suite) {
    case "unit":
      return unit(iteration, extra);
    case "integration":
      return integration(iteration, extra);
    case "focused":
      return [...unit(iteration, extra), ...integration(iteration, extra)];
    case "e2e":
      return entry.target === "cli"
        ? [
            turbo(["test:e2e:run", "--only", "--filter=supabase"], "e2e.1", [
              `--shard=${entry.shard}/${CLI_E2E_SHARDS}`,
            ]),
          ]
        : [turbo(["test:e2e:run", "--only", "--filter=@supabase/cli-e2e"], "e2e.1", [])];
    case "stack-e2e": {
      const files = [`whole-stack.${entry.runtime}.${entry.scenario}`];
      // test.yml runs the public API suite only in this combination.
      if (entry.runtime === "native" && entry.scenario === "lifecycle") {
        files.push("public");
      }
      return files.map((file) => ({
        argv: [
          "pnpm",
          "--dir",
          "packages/stack",
          "run",
          "test:e2e:run",
          `src/${file}.e2e.test.ts`,
          "--passWithNoTests=false",
          ...reporter(`${file}.1`),
        ],
        reports: { dir: "packages/stack", report: `${file}.1` },
      }));
    }
  }
}
