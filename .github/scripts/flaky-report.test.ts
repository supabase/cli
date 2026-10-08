import { describe, expect, test } from "bun:test";
import { aggregate, isClean, parseJunit, renderMarkdown, type RunResult } from "./flaky-report.ts";

function junit(cases: { name: string; failures?: number; skipped?: boolean }[]): string {
  const body = cases
    .map(({ name, failures = 0, skipped = false }) => {
      const inner = [
        ...Array.from(
          { length: failures },
          () =>
            `<failure message="expected 1 to be 2 &amp; &lt;more&gt;" type="AssertionError">\nAssertionError\n</failure>`,
        ),
        skipped ? "<skipped/>" : "",
      ].join("\n");
      return `<testcase classname="src/a.unit.test.ts" name="${name}" time="0.001">\n${inner}\n</testcase>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="vitest tests"><testsuite name="src/a.unit.test.ts">\n${body}\n</testsuite></testsuites>`;
}

/** `reports` maps each collected JUnit file name to its contents. */
function run(
  suite: string,
  runNumber: number,
  reports: Record<string, string>,
  executions = 1,
  exitCode: number | null = 0,
): RunResult {
  return {
    meta: { name: `flaky-${suite}-run${runNumber}`, suite, run: runNumber, executions, exitCode },
    reports: Object.keys(reports),
    cases: Object.values(reports).flatMap((xml) => parseJunit(xml, "apps/cli")),
  };
}

const empty = junit([]);

describe("parseJunit", () => {
  test("reads names, every failed repeat, and skips from Vitest output", () => {
    const cases = parseJunit(
      junit([
        { name: "group &gt; fails &quot;twice&quot;", failures: 2 },
        { name: "group &gt; skipped", skipped: true },
        { name: "group &gt; passes &#x110000;" },
      ]),
      "apps/cli",
    );

    expect(cases).toEqual([
      {
        pkg: "apps/cli",
        file: "src/a.unit.test.ts",
        name: 'group > fails "twice"',
        failures: 2,
        skipped: false,
        message: "expected 1 to be 2 & <more>",
      },
      {
        pkg: "apps/cli",
        file: "src/a.unit.test.ts",
        name: "group > skipped",
        failures: 0,
        skipped: true,
      },
      {
        pkg: "apps/cli",
        file: "src/a.unit.test.ts",
        name: "group > passes &#x110000;",
        failures: 0,
        skipped: false,
      },
    ]);
  });
});

describe("aggregate", () => {
  test("classifies tests per run, keeps same-title tests apart, and reports runs without results", () => {
    const cli = "apps__cli--unit.xml";
    const stack = "packages__stack--unit.xml";
    const report = aggregate(
      [
        run(
          "unit",
          1,
          {
            [cli]: junit([
              { name: "sometimes", failures: 1 },
              { name: "never" },
              { name: "always", failures: 1 },
              { name: "twin" },
              { name: "twin", failures: 1 },
            ]),
            [stack]: empty,
          },
          1,
          1,
        ),
        run(
          "unit",
          2,
          {
            [cli]: junit([
              { name: "sometimes" },
              { name: "never" },
              { name: "always", failures: 1 },
              { name: "twin", skipped: true },
              { name: "twin", failures: 1 },
            ]),
            [stack]: empty,
          },
          1,
          1,
        ),
        run("unit", 3, { [cli]: empty, [stack]: empty }, 1, 1),
        run("unit", 5, { [cli]: junit([{ name: "always", failures: 1 }]) }, 1, 1),
        run("unit", 6, {}, 1, 0),
        run("focused", 1, { [cli]: junit([{ name: "repeated", failures: 2 }]) }, 5, 1),
      ],
      ["1", "2", "3", "4", "5", "6"].map((n) => `flaky-unit-run${n}`).concat("flaky-focused-run1"),
    );

    expect(report.flaky.map((v) => [v.suite, v.name, v.failedRuns, v.runs, v.partialRuns])).toEqual(
      [
        ["focused", "repeated", [1], 1, 1],
        ["unit", "sometimes", [1], 2, 0],
      ],
    );
    expect(report.failing.map((v) => [v.name, v.failedRuns, v.runs])).toEqual([
      ["always", [1, 2, 5], 3],
      ["twin (#2)", [1, 2], 2],
    ]);
    expect(report.runProblems).toEqual([
      {
        name: "flaky-unit-run3",
        problem: "exited 1 without a failing test (setup, unhandled error, or crash)",
      },
      { name: "flaky-unit-run4", problem: "no results uploaded" },
      { name: "flaky-unit-run5", problem: `no JUnit report for ${stack}` },
      { name: "flaky-unit-run6", problem: "exited 0 without writing a JUnit report" },
    ]);
    expect(isClean(report)).toBe(false);
  });

  test("flags runs that ran no tests unless allowed and renders titles without mentions", () => {
    const report = aggregate(
      [
        run(
          "unit",
          1,
          {
            "packages__api--unit.xml": junit([{ name: "@supabase/api &gt; breaks", failures: 1 }]),
          },
          1,
          1,
        ),
        run("unit", 2, { "packages__api--unit.xml": empty }),
        run("integration", 1, { "apps__cli--integration.xml": empty }),
        run("focused", 1, { "apps__cli--unit.xml": empty }),
      ],
      ["flaky-unit-run1", "flaky-unit-run2", "flaky-integration-run1", "flaky-focused-run1"],
      ["focused"],
    );

    const markdown = renderMarkdown(report, {
      sha: "0123456789abcdef",
      runUrl: "https://example.test/run",
    });

    expect(report.runProblems).toEqual([
      { name: "flaky-integration-run1", problem: "ran no tests; check the filter" },
      { name: "flaky-unit-run2", problem: "ran no tests; check the filter" },
      ,
    ]);
    expect(markdown).toContain("| unit | @<!---->supabase/api > breaks |");
  });

  test("a clean report renders the PR comment marker and per-suite totals", () => {
    const report = aggregate(
      [
        run("unit", 1, { "apps__cli--unit.xml": junit([{ name: "ok" }]) }),
        run("unit", 2, { "apps__cli--unit.xml": junit([{ name: "ok" }]) }),
      ],
      ["flaky-unit-run1", "flaky-unit-run2"],
    );

    const markdown = renderMarkdown(report, {
      sha: "0123456789abcdef",
      runUrl: "https://example.test/run",
    });

    expect(isClean(report)).toBe(true);
    expect(markdown.split("\n").slice(0, 4)).toEqual([
      "<!-- flaky-check -->",
      "## Flaky test check: ✅ no flaky tests",
      "",
      "Commit `0123456789ab` · unit ×2, 1 test · [workflow run](https://example.test/run)",
    ]);
  });
});
