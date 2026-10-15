import { describe, expect, test } from "bun:test";
import type { JsonTestResults } from "vitest/node";
import {
  aggregate,
  commentBody,
  isClean,
  parseVitestJson,
  renderMarkdown,
  type RunMeta,
  type RunResult,
} from "./report.ts";

// Real `--reporter=json` output, trimmed to the fields read, of the same three probe files run twice. The second iteration
// fails one test, fails another together with its `afterEach`, and fails a file's `beforeAll`;
// both iterations fail the second of two same-titled tests and a file that throws on import.
const iteration1: JsonTestResults = await Bun.file(
  `${import.meta.dir}/fixtures/iteration-1.json`,
).json();
const iteration2: JsonTestResults = await Bun.file(
  `${import.meta.dir}/fixtures/iteration-2.json`,
).json();
// What Vitest reports for a healthy file: the hook file from the first iteration.
const clean: JsonTestResults = {
  ...iteration1,
  testResults: iteration1.testResults.filter((file) => file.name.endsWith("hook.unit.test.ts")),
};
const empty: JsonTestResults = { ...iteration1, testResults: [] };
const API = "packages__api--unit";

function run(
  suite: string,
  runNumber: number,
  reports: Record<string, JsonTestResults>,
  meta: Partial<RunMeta> = {},
): RunResult {
  const exitCode = meta.exitCode === undefined ? 0 : meta.exitCode;
  return {
    meta: {
      name: `flaky-${suite}-run${runNumber}`,
      suite,
      run: runNumber,
      executions: 1,
      exitCode,
      root: "/repo",
      expectedReports: Object.keys(reports),
      failedInvocations:
        exitCode === null || exitCode === 0 ? [] : [{ reports: Object.keys(reports), exitCode }],
      ...meta,
    },
    reports: Object.entries(reports).map(([name, results]) => ({
      name,
      iteration: Number(/\.(\d+)\.json$/.exec(name)?.[1]),
      cases: parseVitestJson(results, "/repo"),
    })),
  };
}

function summary(results: RunResult[], expected: string[]) {
  const report = aggregate(results, expected);
  const rows = (verdicts: typeof report.flaky) =>
    verdicts.map((v) => [
      v.file.split("/").pop(),
      v.name,
      `${v.failedIn.length}/${v.executions}`,
      v.message,
    ]);
  return {
    flaky: rows(report.flaky),
    failing: rows(report.failing),
    runProblems: report.runProblems,
  };
}

describe("aggregate", () => {
  test("executions classify tests the same whether they are iterations of one run or separate runs", () => {
    const expected = {
      flaky: [
        ["hook.unit.test.ts", "(file setup)", "1/2", "failed outside any test (hook or setup)"],
        [
          "probe.unit.test.ts",
          "sometimes > fails on the second iteration",
          "1/2",
          "Error: second iteration",
        ],
        [
          "probe.unit.test.ts",
          "two errors > test and afterEach both fail on the second iteration",
          "1/2",
          "Error: test body",
        ],
      ],
      failing: [
        ["import-error.unit.test.ts", "(file setup)", "2/2", "import failure"],
        ["probe.unit.test.ts", "@supabase/api > twin (#2)", "2/2", "Error: second twin"],
      ],
      runProblems: [],
    };

    const iterations = summary(
      [
        run(
          "focused",
          1,
          { [`${API}.1.json`]: iteration1, [`${API}.2.json`]: iteration2 },
          { executions: 2, exitCode: 1 },
        ),
      ],
      ["flaky-focused-run1"],
    );
    const runs = summary(
      [
        run("unit", 1, { [`${API}.1.json`]: iteration1 }, { exitCode: 1 }),
        run("unit", 2, { [`${API}.1.json`]: iteration2 }, { exitCode: 1 }),
      ],
      ["flaky-unit-run1", "flaky-unit-run2"],
    );

    expect(iterations).toEqual(expected);
    expect(runs).toEqual(expected);
  });

  test("scenarios sharing a file stay separate, and a failing setup is not an empty run", () => {
    const hook = (results: JsonTestResults): JsonTestResults => ({
      ...results,
      testResults: results.testResults.filter((file) => file.name.endsWith("hook.unit.test.ts")),
    });
    const lifecycle = "packages__stack--whole-stack.docker.lifecycle.1.json";
    const confinement = "packages__stack--whole-stack.docker.confinement.1.json";
    const results = [1, 2].flatMap((n) => [
      run(
        "stack-e2e",
        n,
        { [lifecycle]: hook(iteration2) },
        { name: `lifecycle${n}`, exitCode: 1 },
      ),
      run("stack-e2e", n, { [confinement]: hook(iteration1) }, { name: `confinement${n}` }),
    ]);

    const report = summary(results, ["lifecycle1", "confinement1", "lifecycle2", "confinement2"]);

    expect(report).toEqual({
      flaky: [],
      failing: [
        [
          "hook.unit.test.ts",
          "(file setup) [whole-stack.docker.lifecycle]",
          "2/2",
          "failed outside any test (hook or setup)",
        ],
      ],
      runProblems: [],
    });
  });

  test("a file whose tests were all skipped does not count as a passing setup", () => {
    const [hookFile] = clean.testResults;
    const failingHook: JsonTestResults = {
      ...iteration2,
      testResults: iteration2.testResults.filter((file) => file.name.endsWith("hook.unit.test.ts")),
    };
    const skippedHook: JsonTestResults = {
      ...clean,
      testResults: [
        {
          ...hookFile!,
          assertionResults: hookFile!.assertionResults.map((a) => ({ ...a, status: "skipped" })),
        },
        { ...hookFile!, name: "/repo/other.unit.test.ts" },
      ],
    };

    const report = summary(
      [
        run("unit", 1, { [`${API}.1.json`]: failingHook }, { exitCode: 1 }),
        run("unit", 2, { [`${API}.1.json`]: skippedHook }),
      ],
      ["flaky-unit-run1", "flaky-unit-run2"],
    );

    expect(report).toEqual({
      flaky: [],
      failing: [
        ["hook.unit.test.ts", "(file setup)", "1/1", "failed outside any test (hook or setup)"],
      ],
      runProblems: [],
    });
  });

  test("reports runs that lost an expected report, crashed, ran nothing in some execution, or never uploaded", () => {
    const report = aggregate(
      [
        run(
          "unit",
          1,
          { [`${API}.1.json`]: clean },
          { expectedReports: [`${API}.1.json`, "apps__cli--unit.1.json"] },
        ),
        run("unit", 2, { [`${API}.1.json`]: clean }, { exitCode: 1 }),
        run("unit", 3, { [`${API}.1.json`]: empty }),
        run("unit", 4, {}, { exitCode: null }),
        run(
          "integration",
          1,
          { "apps__cli--integration.1.json": iteration2, [`${API}.1.json`]: clean },
          {
            exitCode: 1,
            failedInvocations: [
              { reports: ["apps__cli--integration.1.json"], exitCode: 1 },
              { reports: [`${API}.1.json`], exitCode: 1 },
            ],
          },
        ),
        run("focused", 1, { [`${API}.1.json`]: empty }),
        run(
          "focused",
          2,
          { [`${API}.1.json`]: clean, [`${API}.2.json`]: empty },
          { executions: 2 },
        ),
      ],
      ["1", "2", "3", "4", "5"]
        .map((n) => `flaky-unit-run${n}`)
        .concat("flaky-focused-run1", "flaky-focused-run2", "flaky-integration-run1"),
      ["focused"],
    );

    expect(report.runProblems).toEqual([
      { name: "flaky-focused-run2", problem: "ran no tests in iteration 2" },
      {
        name: "flaky-integration-run1",
        problem: `${API}.1.json exited 1 without a failing test (unhandled error or crash)`,
      },
      { name: "flaky-unit-run1", problem: "no report for apps__cli--unit.1.json" },
      {
        name: "flaky-unit-run2",
        problem: `${API}.1.json exited 1 without a failing test (unhandled error or crash)`,
      },
      { name: "flaky-unit-run3", problem: "ran no tests; check the filter" },
      {
        name: "flaky-unit-run4",
        problem:
          "test step did not run or finish (setup failure, flaky-check error, timeout, or cancel); see the job log",
      },
      {
        name: "flaky-unit-run5",
        problem: "no results uploaded (the job failed before collecting, such as in setup)",
      },
    ]);
    expect([report.flaky, report.failing.filter((v) => v.suite !== "integration")]).toEqual([
      [],
      [],
    ]);
  });
});

describe("renderMarkdown", () => {
  test("a failing report escapes mentions and locates iterations, and a clean one leads with the marker", () => {
    const context = { sha: "0123456789abcdef", runUrl: "https://example.test/run" };
    const failing = renderMarkdown(
      aggregate(
        [
          run(
            "focused",
            1,
            { [`${API}.1.json`]: iteration1, [`${API}.2.json`]: iteration2 },
            { executions: 2, exitCode: 1 },
          ),
        ],
        ["flaky-focused-run1"],
      ),
      context,
    );
    const cleanReport = aggregate(
      [run("unit", 1, { [`${API}.1.json`]: clean })],
      ["flaky-unit-run1"],
    );
    const cleanMarkdown = renderMarkdown(cleanReport, context);

    expect(failing).toContain(
      "| focused | sometimes > fails on the second iteration | `packages/api/src/probe.unit.test.ts` | 1/2 | 1.2 | Error: second iteration |",
    );
    expect(failing).toContain("| focused | @<!---->supabase/api > twin (#2) |");
    expect(commentBody(failing)).toBe(failing);
    expect(commentBody(failing.repeat(200))).toHaveLength(65_000);
    expect(commentBody(failing.repeat(200))).toEndWith("`flaky-check-report` artifact.\n");
    expect(isClean(cleanReport)).toBe(true);
    expect(cleanMarkdown.split("\n").slice(0, 4)).toEqual([
      "<!-- flaky-check -->",
      "## Flaky test check: ✅ no flaky tests",
      "",
      "Commit `0123456789ab` · unit ×1, 1 test · [workflow run](https://example.test/run)",
    ]);
  });
});
