import { describe, expect, test } from "bun:test";
import { commandsFor, type RunSpec } from "./commands.ts";

function reportOf(argv: string[]): string | undefined {
  return argv
    .find((arg) => arg.startsWith("--outputFile.json="))
    ?.slice("--outputFile.json=".length);
}

describe("commandsFor", () => {
  test("integration runs both @supabase/api projects outside Turbo, each with its own report", () => {
    expect(commandsFor({ suite: "integration", filters: ["src/a"] })).toEqual([
      [
        "pnpm",
        "exec",
        "turbo",
        "run",
        "test:integration:run",
        "--continue=always",
        "--filter=!@supabase/api",
        "--",
        "--reporter=default",
        "--reporter=json",
        "--outputFile.json=.flaky-results/integration.json",
        "--passWithNoTests",
        "src/a",
      ],
      [
        "pnpm",
        "--dir",
        "packages/api",
        "exec",
        "vitest",
        "run",
        "--project",
        "integration",
        "--reporter=default",
        "--reporter=json",
        "--outputFile.json=.flaky-results/integration-node.json",
        "--passWithNoTests",
        "src/a",
      ],
      [
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
        "--outputFile.json=.flaky-results/integration-bun.json",
        "--passWithNoTests",
        "src/a",
      ],
    ]);
  });

  test("focused repeats unit and integration tests changed since the merge base", () => {
    const commands = commandsFor({
      suite: "focused",
      repeats: 4,
      selection: { changedSince: "abc123" },
    });

    expect(commands.map(reportOf)).toEqual([
      ".flaky-results/unit.json",
      ".flaky-results/integration.json",
      ".flaky-results/integration-node.json",
      ".flaky-results/integration-bun.json",
    ]);
    for (const argv of commands) {
      expect(argv.slice(-3)).toEqual(["--repeats=4", "--changed", "abc123"]);
    }
  });

  const cases: [RunSpec, string[][]][] = [
    [{ suite: "unit", filters: [] }, [["test:unit", "unit.json"]]],
    [{ suite: "e2e", target: "cli", shard: 2 }, [["--shard=2/4", "e2e.json"]]],
    [{ suite: "e2e", target: "cli-e2e", shard: 0 }, [["--filter=@supabase/cli-e2e", "e2e.json"]]],
    [
      { suite: "stack-e2e", runtime: "native", scenario: "lifecycle" },
      [
        ["src/whole-stack.native.lifecycle.e2e.test.ts", "whole-stack.native.lifecycle.json"],
        ["src/public.e2e.test.ts", "public.json"],
      ],
    ],
    [
      { suite: "stack-e2e", runtime: "podman", scenario: "idle-parallel" },
      [
        [
          "src/whole-stack.podman.idle-parallel.e2e.test.ts",
          "whole-stack.podman.idle-parallel.json",
        ],
      ],
    ],
  ];

  test.each(cases)("%j runs its commands with distinct reports", (spec, expected) => {
    const commands = commandsFor(spec);

    expect(
      commands.map((argv) => [
        expected.find(([arg]) => argv.includes(arg ?? ""))?.[0],
        reportOf(argv),
      ]),
    ).toEqual(expected.map(([arg, report]) => [arg, `.flaky-results/${report}`]));
  });
});
