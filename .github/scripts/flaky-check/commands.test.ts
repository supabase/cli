import { describe, expect, test } from "bun:test";
import { commandsFor, type ReportSource, type RunSpec } from "./commands.ts";

function outputOf(argv: string[]): string | undefined {
  return argv
    .find((arg) => arg.startsWith("--outputFile.json="))
    ?.slice("--outputFile.json=".length);
}

describe("commandsFor", () => {
  test("integration runs both @supabase/api projects outside Turbo, each with its own report", () => {
    const invocations = commandsFor({ suite: "integration", filters: ["src/a"] });

    expect(invocations.map((invocation) => invocation.reports)).toEqual([
      { turbo: ["test:integration:run", "--filter=!@supabase/api"], report: "integration.1" },
      { dir: "packages/api", report: "integration-node.1" },
      { dir: "packages/api", report: "integration-bun.1" },
    ]);
    expect(invocations[2]?.argv).toEqual([
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
      "--reporter=default",
      "--reporter=json",
      "--outputFile.json=.flaky-results/integration-bun.1.json",
      "--passWithNoTests",
      "src/a",
    ]);
  });

  test("each focused iteration writes its own reports for the tests changed since the merge base", () => {
    const invocations = commandsFor({ suite: "focused", selection: { changedSince: "abc123" } }, 3);

    expect(invocations.map((invocation) => outputOf(invocation.argv))).toEqual([
      ".flaky-results/unit.3.json",
      ".flaky-results/integration.3.json",
      ".flaky-results/integration-node.3.json",
      ".flaky-results/integration-bun.3.json",
    ]);
    for (const { argv } of invocations) {
      expect(argv.slice(-2)).toEqual(["--changed", "abc123"]);
      expect(argv.some((arg) => arg.startsWith("--repeats"))).toBe(false);
    }
  });

  const cases: [RunSpec, string, ReportSource[]][] = [
    [
      { suite: "unit", filters: [] },
      "--passWithNoTests",
      [{ turbo: ["test:unit:run", "--filter=!@supabase/cli-go"], report: "unit.1" }],
    ],
    [
      { suite: "e2e", target: "cli", shard: 2 },
      "--shard=2/4",
      [{ turbo: ["test:e2e:run", "--only", "--filter=supabase"], report: "e2e.1" }],
    ],
    [
      { suite: "e2e", target: "cli-e2e", shard: 0 },
      "--filter=@supabase/cli-e2e",
      [{ turbo: ["test:e2e:run", "--only", "--filter=@supabase/cli-e2e"], report: "e2e.1" }],
    ],
    [
      { suite: "stack-e2e", runtime: "native", scenario: "lifecycle" },
      "src/whole-stack.native.lifecycle.e2e.test.ts",
      [
        { dir: "packages/stack", report: "whole-stack.native.lifecycle.1" },
        { dir: "packages/stack", report: "public.1" },
      ],
    ],
    [
      { suite: "stack-e2e", runtime: "podman", scenario: "idle-parallel" },
      "src/whole-stack.podman.idle-parallel.e2e.test.ts",
      [{ dir: "packages/stack", report: "whole-stack.podman.idle-parallel.1" }],
    ],
  ];

  test.each(cases)("%j declares where each report lands", (spec, arg, reports) => {
    const invocations = commandsFor(spec);

    expect(invocations.map((invocation) => invocation.reports)).toEqual(reports);
    expect(invocations.map((invocation) => outputOf(invocation.argv))).toEqual(
      reports.map((source) => `.flaky-results/${source.report}.json`),
    );
    expect(invocations[0]?.argv).toContain(arg);
  });
});
