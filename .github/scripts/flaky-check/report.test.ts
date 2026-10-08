import { describe, expect, test } from "bun:test";
import type { JsonAssertionResult, JsonTestResults } from "vitest/node";
import {
  aggregate,
  isClean,
  parseVitestJson,
  renderMarkdown,
  type RunMeta,
  type RunResult,
} from "./report.ts";

// Real `--reporter=json --repeats=2` output (three executions per test): one test fails once,
// one fails once with an `afterEach` error too, a `beforeAll` fails, the second of two
// same-titled tests always fails, and a second file throws on import.
const fixture: JsonTestResults = await Bun.file(
  `${import.meta.dir}/fixtures/vitest-repeats.json`,
).json();

function withPassing(results: JsonTestResults, titles: string[]): JsonTestResults {
  const copy: JsonTestResults = structuredClone(results);
  for (const file of copy.testResults) {
    for (const assertion of file.assertionResults) {
      if (titles.includes(assertion.title)) {
        Object.assign(assertion, {
          status: "passed",
          failureMessages: [],
        } satisfies Partial<JsonAssertionResult>);
      }
    }
  }
  return copy;
}

function run(
  suite: string,
  runNumber: number,
  reports: Record<string, JsonTestResults>,
  meta: Partial<RunMeta> = {},
): RunResult {
  return {
    meta: {
      name: `flaky-${suite}-run${runNumber}`,
      suite,
      run: runNumber,
      executions: 1,
      exitCode: 0,
      root: "/repo",
      ...meta,
    },
    reports: Object.keys(reports),
    cases: Object.values(reports).flatMap((results) => parseVitestJson(results, "/repo")),
  };
}

const empty: JsonTestResults = { ...fixture, testResults: [] };
const probe = fixture.testResults[0]!;
// What Vitest reports for a healthy file: the probe file reduced to its one passing test.
const clean: JsonTestResults = {
  ...fixture,
  testResults: [
    {
      ...probe,
      status: "passed",
      assertionResults: probe.assertionResults.filter((a) => a.status === "passed"),
    },
  ],
};

describe("parseVitestJson", () => {
  test("keeps every failure message, skips, and a file-level entry for setup and import failures", () => {
    const cases = parseVitestJson(fixture, "/repo");

    expect(
      cases.map((c) => [
        c.file.split("/").pop(),
        c.titles.join(" > "),
        c.failures,
        c.skipped,
        c.message,
      ]),
    ).toEqual([
      [
        "probe.unit.test.ts",
        "mixed > fails only on the second execution",
        1,
        false,
        "Error: second",
      ],
      [
        "probe.unit.test.ts",
        "two errors > test and afterEach both fail once",
        2,
        false,
        "Error: test body",
      ],
      ["probe.unit.test.ts", "hook > never runs", 0, true, undefined],
      ["probe.unit.test.ts", "@supabase/api > twin", 0, false, undefined],
      ["probe.unit.test.ts", "@supabase/api > twin", 3, false, "Error: second twin"],
      ["probe.unit.test.ts", "@supabase/api > skipped", 0, true, undefined],
      ["probe.unit.test.ts", "(file setup)", 0, false, undefined],
      ["import-error.unit.test.ts", "(file setup)", 1, false, "import failure"],
    ]);
    expect(cases[0]?.file).toBe("packages/api/src/probe.unit.test.ts");
  });
});

describe("aggregate", () => {
  test("classifies repeated runs: partial failures are flaky, failures in every execution of every run are not", () => {
    const report = aggregate(
      [
        run("focused", 1, { "packages__api--unit.json": fixture }, { executions: 3, exitCode: 1 }),
        run(
          "focused",
          2,
          {
            "packages__api--unit.json": withPassing(fixture, [
              "fails only on the second execution",
              "test and afterEach both fail once",
            ]),
          },
          { executions: 3, exitCode: 1 },
        ),
      ],
      ["flaky-focused-run1", "flaky-focused-run2"],
    );

    expect(report.flaky.map((v) => [v.name, v.failedRuns, v.partialRuns])).toEqual([
      ["mixed > fails only on the second execution", [1], 1],
      ["two errors > test and afterEach both fail once", [1], 1],
    ]);
    expect(report.failing.map((v) => [v.file.split("/").pop(), v.name, v.failedRuns])).toEqual([
      ["import-error.unit.test.ts", "(file setup)", [1, 2]],
      ["probe.unit.test.ts", "@supabase/api > twin (#2)", [1, 2]],
    ]);
    expect(report.runProblems).toEqual([]);
    expect(report.suites).toEqual([{ suite: "focused", runs: 2, executions: 3, tests: 4 }]);
  });

  test("reports runs that crashed, lost a report, ran nothing, or never uploaded", () => {
    const api = "packages__api--unit.json";
    const cli = "apps__cli--unit.json";
    const report = aggregate(
      [
        run("unit", 1, { [api]: clean, [cli]: clean }),
        run("unit", 2, { [api]: clean }, { exitCode: 1 }),
        run("unit", 3, { [api]: clean, [cli]: clean }, { exitCode: 1 }),
        run("unit", 4, { [api]: empty, [cli]: empty }),
        run("unit", 5, {}, { exitCode: null }),
        run("focused", 1, { [api]: empty }),
      ],
      ["1", "2", "3", "4", "5", "6"].map((n) => `flaky-unit-run${n}`).concat("flaky-focused-run1"),
      ["focused"],
    );

    expect(report.runProblems).toEqual([
      { name: "flaky-unit-run2", problem: `no report for ${cli}` },
      {
        name: "flaky-unit-run3",
        problem: "exited 1 without a failing test (unhandled error or crash)",
      },
      { name: "flaky-unit-run4", problem: "ran no tests; check the filter" },
      {
        name: "flaky-unit-run5",
        problem: "test step did not run or finish (setup failure, timeout, or cancel)",
      },
      { name: "flaky-unit-run6", problem: "no results uploaded" },
    ]);
    expect([report.flaky, report.failing]).toEqual([[], []]);
  });
});

describe("renderMarkdown", () => {
  test("a failing report escapes mentions, and a clean one leads with the PR comment marker", () => {
    const failing = renderMarkdown(
      aggregate(
        [run("unit", 1, { "packages__api--unit.json": fixture }, { exitCode: 1 })],
        ["flaky-unit-run1"],
      ),
      { sha: "0123456789abcdef", runUrl: "https://example.test/run" },
    );
    const cleanReport = aggregate(
      [run("unit", 1, { "packages__api--unit.json": clean })],
      ["flaky-unit-run1"],
    );
    const cleanMarkdown = renderMarkdown(cleanReport, {
      sha: "0123456789abcdef",
      runUrl: "https://example.test/run",
    });

    expect(failing).toContain(
      "| unit | @<!---->supabase/api > twin (#2) | `packages/api/src/probe.unit.test.ts` | 1/1 | 1 |",
    );
    expect(isClean(cleanReport)).toBe(true);
    expect(cleanMarkdown.split("\n").slice(0, 4)).toEqual([
      "<!-- flaky-check -->",
      "## Flaky test check: ✅ no flaky tests",
      "",
      "Commit `0123456789ab` · unit ×1, 1 test · [workflow run](https://example.test/run)",
    ]);
  });
});
