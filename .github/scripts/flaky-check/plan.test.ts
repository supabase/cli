import { describe, expect, test } from "bun:test";
import { CheckError, commandsFor, type Entry, plan, type PlanInput, WEEKLY_CRON } from "./plan.ts";

const input = (overrides: Partial<PlanInput>): PlanInput => ({
  event: "workflow_dispatch",
  schedule: "",
  baseRef: "",
  suites: "unit",
  runs: "1",
  repeats: "4",
  filter: "",
  ...overrides,
});

function entry(name: string): Entry {
  const found = plan(input({ suites: "unit,integration,focused,e2e,stack-e2e" })).entries.find(
    (e) => e.name === name,
  );
  if (found === undefined) {
    throw new Error(`no plan entry ${name}`);
  }
  return found;
}

function outputOf(argv: string[]): string | undefined {
  return argv
    .find((arg) => arg.startsWith("--outputFile.json="))
    ?.slice("--outputFile.json=".length);
}

describe("plan", () => {
  test("schedules run unit and integration nightly and the e2e suites on the workflow's weekly cron", async () => {
    const workflow = await Bun.file(`${import.meta.dir}/../../workflows/flaky-check.yml`).text();
    expect(JSON.stringify(Bun.YAML.parse(workflow))).toContain(`"cron":"${WEEKLY_CRON}"`);

    const weekly = plan(input({ event: "schedule", schedule: WEEKLY_CRON })).entries;
    const nightly = plan(input({ event: "schedule", schedule: "17 3 * * *" })).entries;

    expect(weekly.map((e) => e.name).slice(0, 6)).toEqual([
      "flaky-e2e-cli1-run1",
      "flaky-e2e-cli2-run1",
      "flaky-e2e-cli3-run1",
      "flaky-e2e-cli4-run1",
      "flaky-e2e-cli-e2e-run1",
      "flaky-e2e-cli1-run2",
    ]);
    expect(weekly).toHaveLength(33);
    expect(nightly.map((e) => [e.suite, e.runner, e.timeout]).slice(9, 11)).toEqual([
      ["unit", "blacksmith-4vcpu-ubuntu-2404", 30],
      ["integration", "blacksmith-8vcpu-ubuntu-2404", 30],
    ]);
    expect(nightly).toHaveLength(20);
  });

  test("a labeled pull request adds focused jobs that run five executions against the PR base", () => {
    const { entries, base } = plan(input({ event: "pull_request", baseRef: "next" }));

    expect(base).toBe("next");
    expect(
      entries
        .filter((e) => e.suite === "focused")
        .map((e) => [e.executions, e.fetchDepth, e.timeout]),
    ).toEqual(Array(10).fill([5, 0, 60]));
  });

  test("a dispatch normalizes its inputs and stays within GitHub's matrix limit", () => {
    const { entries, filter } = plan(
      input({ suites: " focused , unit ", runs: " 2", repeats: "9", filter: " src/a.ts " }),
    );

    expect(entries.map((e) => [e.name, e.executions])).toEqual([
      ["flaky-unit-run1", 1],
      ["flaky-unit-run2", 1],
      ["flaky-focused-run1", 10],
      ["flaky-focused-run2", 10],
    ]);
    expect(filter).toBe("src/a.ts");
    expect(() =>
      plan(input({ suites: "unit,integration,focused,e2e,stack-e2e", runs: "30" })),
    ).toThrow("420 jobs exceed GitHub's 256-job matrix limit");
  });

  test.each([
    [{ suites: "unit,bogus" }, "unknown suite 'bogus'"],
    [{ suites: " , " }, "no suites selected"],
    [{ runs: "1.5" }, "runs must be a whole number between 1 and 30, got '1.5'"],
  ])("rejects %j", (overrides, message) => {
    expect(() => plan(input(overrides))).toThrow(CheckError);
    expect(() => plan(input(overrides))).toThrow(message);
  });
});

describe("commandsFor", () => {
  test("each focused iteration runs both @supabase/api projects outside Turbo, with its own reports", () => {
    const invocations = commandsFor(entry("flaky-focused-run1"), 3, ["--changed", "abc123"]);

    expect(invocations.map((i) => [i.reports, outputOf(i.argv)])).toEqual([
      [
        { turbo: ["test:unit:run", "--filter=!@supabase/cli-go"], report: "unit.3" },
        ".flaky-results/unit.3.json",
      ],
      [
        { turbo: ["test:integration:run", "--filter=!@supabase/api"], report: "integration.3" },
        ".flaky-results/integration.3.json",
      ],
      [
        { dir: "packages/api", report: "integration-node.3" },
        ".flaky-results/integration-node.3.json",
      ],
      [
        { dir: "packages/api", report: "integration-bun.3" },
        ".flaky-results/integration-bun.3.json",
      ],
    ]);
    expect(invocations[3]?.argv.slice(0, 10)).toEqual([
      "pnpm",
      "--dir",
      "packages/api",
      "exec",
      "bun",
      "--bun",
      "vitest",
      "run",
      "--project",
      "bun-integration",
    ]);
    for (const { argv } of invocations) {
      expect(argv.slice(-2)).toEqual(["--changed", "abc123"]);
    }
  });

  test.each([
    [
      "flaky-e2e-cli2-run1",
      [{ turbo: ["test:e2e:run", "--only", "--filter=supabase"], report: "e2e.1" }],
      "--shard=2/4",
    ],
    [
      "flaky-e2e-cli-e2e-run1",
      [{ turbo: ["test:e2e:run", "--only", "--filter=@supabase/cli-e2e"], report: "e2e.1" }],
      "--",
    ],
    [
      "flaky-stack-e2e-native-lifecycle-run1",
      [
        { dir: "packages/stack", report: "whole-stack.native.lifecycle.1" },
        { dir: "packages/stack", report: "public.1" },
      ],
      "src/whole-stack.native.lifecycle.e2e.test.ts",
    ],
    [
      "flaky-stack-e2e-podman-idle-parallel-run1",
      [{ dir: "packages/stack", report: "whole-stack.podman.idle-parallel.1" }],
      "src/whole-stack.podman.idle-parallel.e2e.test.ts",
    ],
  ])("%s declares where each report lands", (name, reports, arg) => {
    const invocations = commandsFor(entry(name), 1, ["ignored-filter"]);

    expect(invocations.map((i) => i.reports)).toEqual(reports);
    expect(invocations.map((i) => outputOf(i.argv))).toEqual(
      reports.map((r) => `.flaky-results/${r.report}.json`),
    );
    expect(invocations[0]?.argv).toContain(arg);
    expect(invocations[0]?.argv).not.toContain("ignored-filter");
  });
});
