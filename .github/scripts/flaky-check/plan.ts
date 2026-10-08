const SUITES = ["unit", "integration", "focused", "e2e", "stack-e2e"] as const;
type Suite = (typeof SUITES)[number];

export const WEEKLY_CRON = "47 3 * * 0";
const MAX_RUNS = 30;
const MAX_REPEATS = 100;
const DEFAULT_REPEATS = 4;
export const CLI_E2E_SHARDS = 4;

export type PlanInput =
  | { event: "schedule"; schedule: string }
  | { event: "pull_request"; baseRef: string }
  | { event: "workflow_dispatch"; suites: string; runs: string; repeats: string; filter: string };

type TestsEntry = {
  suite: "unit" | "integration" | "focused";
  run: number;
  name: string;
  /** Executions of each test per run: `--repeats` + 1 for focused, otherwise 1. */
  executions: number;
};
export type E2eEntry = { target: "cli" | "cli-e2e"; shard: number; run: number; name: string };
export type StackEntry = {
  runtime: "native" | "docker" | "podman";
  scenario: "lifecycle" | "idle-parallel";
  run: number;
  name: string;
};

export type Plan = {
  suites: Suite[];
  runs: number;
  repeats: number;
  filter: string;
  /** Branch that focused runs diff against. */
  base: string;
  tests: TestsEntry[];
  e2e: E2eEntry[];
  stack: StackEntry[];
  /** Artifact names the report expects, one per matrix job. */
  expected: string[];
};

export class PlanError extends Error {}

function parseCount(value: string, label: string, min: number, max: number): number {
  const count = Number(value.trim());
  if (!Number.isInteger(count) || count < min || count > max) {
    throw new PlanError(
      `${label} must be a whole number between ${min} and ${max}, got '${value}'`,
    );
  }
  return count;
}

function parseSuites(value: string): Suite[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  for (const name of names) {
    if (!SUITES.some((suite) => suite === name)) {
      throw new PlanError(`unknown suite '${name}'; choose from ${SUITES.join(",")}`);
    }
  }
  const suites = SUITES.filter((suite) => names.includes(suite));
  if (suites.length === 0) {
    throw new PlanError(`no suites selected; choose from ${SUITES.join(",")}`);
  }
  return suites;
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

export function plan(input: PlanInput): Plan {
  let suites: Suite[];
  let runs: number;
  let repeats = DEFAULT_REPEATS;
  let filter = "";
  let base = "develop";
  switch (input.event) {
    case "schedule":
      [suites, runs] =
        input.schedule === WEEKLY_CRON ? [["e2e", "stack-e2e"], 3] : [["unit", "integration"], 10];
      break;
    case "pull_request":
      suites = ["unit", "integration", "focused"];
      runs = 10;
      base = input.baseRef;
      break;
    case "workflow_dispatch":
      suites = parseSuites(input.suites);
      runs = parseCount(input.runs, "runs", 1, MAX_RUNS);
      repeats = parseCount(input.repeats, "repeats", 0, MAX_REPEATS);
      filter = input.filter.trim();
      break;
  }

  const tests = suites.flatMap((suite) =>
    suite === "unit" || suite === "integration" || suite === "focused"
      ? range(runs).map((run) => ({
          suite,
          run,
          name: `flaky-${suite}-run${run}`,
          executions: suite === "focused" ? repeats + 1 : 1,
        }))
      : [],
  );
  const e2e: E2eEntry[] = suites.includes("e2e")
    ? range(runs).flatMap((run) => [
        ...range(CLI_E2E_SHARDS).map((shard) => ({
          target: "cli" as const,
          shard,
          run,
          name: `flaky-e2e-cli${shard}-run${run}`,
        })),
        { target: "cli-e2e" as const, shard: 0, run, name: `flaky-e2e-cli-e2e-run${run}` },
      ])
    : [];
  const stack: StackEntry[] = suites.includes("stack-e2e")
    ? range(runs).flatMap((run) =>
        (["native", "docker", "podman"] as const).flatMap((runtime) =>
          (["lifecycle", "idle-parallel"] as const).map((scenario) => ({
            runtime,
            scenario,
            run,
            name: `flaky-stack-e2e-${runtime}-${scenario}-run${run}`,
          })),
        ),
      )
    : [];

  return {
    suites,
    runs,
    repeats,
    filter,
    base,
    tests,
    e2e,
    stack,
    expected: [...tests, ...e2e, ...stack].map((entry) => entry.name),
  };
}

/** A GitHub Actions matrix value, or an empty string so the job's `if` can skip it. */
export function matrix(entries: readonly object[]): string {
  return entries.length === 0 ? "" : JSON.stringify({ include: entries });
}
