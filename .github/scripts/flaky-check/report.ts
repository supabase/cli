import { relative } from "node:path";
import type { JsonTestResults } from "vitest/node";

export const COMMENT_MARKER = "<!-- flaky-check -->";
const MAX_ROWS = 50;
const MAX_MESSAGE = 200;
const FILE_LEVEL_TITLE = "(file setup)";
const SKIPPED = new Set(["skipped", "pending", "todo", "disabled"]);

/** What one matrix job recorded next to its Vitest JSON reports in `meta.json`. */
export type RunMeta = {
  name: string;
  suite: string;
  run: number;
  /** Executions of each test in this run: 1, or `--repeats` + 1. */
  executions: number;
  /** `null` when the test step did not run or finish, such as after a setup failure or timeout. */
  exitCode: number | null;
  /** Checkout root the reports' absolute file paths are relative to. */
  root: string;
};

export type TestCase = {
  file: string;
  titles: string[];
  failures: number;
  skipped: boolean;
  /** Set for file-level entries, which run once regardless of `--repeats`. */
  executions?: number;
  message?: string;
};

/** `reports` names the JSON reports the run produced, one per Vitest invocation. */
export type RunResult = { meta: RunMeta; reports: string[]; cases: TestCase[] };

type TestVerdict = {
  suite: string;
  file: string;
  name: string;
  runs: number;
  failedRuns: number[];
  /** Failed runs in which other executions of the test passed (only possible with `--repeats`). */
  partialRuns: number;
  message?: string;
};

type RunProblem = { name: string; problem: string };

export type Report = {
  flaky: TestVerdict[];
  failing: TestVerdict[];
  runProblems: RunProblem[];
  suites: { suite: string; runs: number; executions: number; tests: number }[];
};

function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

/**
 * Flattens one Vitest JSON report. Every failed execution adds a failure message, and one
 * execution can add several (a failing test and its failing `afterEach`, for example). Each file
 * also gets a file-level entry, because a failing `beforeAll` or import only marks the file failed.
 */
export function parseVitestJson(results: JsonTestResults, root: string): TestCase[] {
  return results.testResults.flatMap((fileResult) => {
    const file = relative(root, fileResult.name);
    const tests = fileResult.assertionResults.map((assertion) => {
      const failureMessages = assertion.failureMessages ?? [];
      const message = failureMessages[0];
      return {
        file,
        titles: [...assertion.ancestorTitles, assertion.title],
        failures: failureMessages.length,
        skipped: SKIPPED.has(assertion.status),
        ...(message === undefined ? {} : { message: firstLine(message) }),
      };
    });
    const fileFailed =
      fileResult.status === "failed" &&
      (fileResult.message !== "" || tests.every((test) => test.failures === 0));
    return [
      ...tests,
      {
        file,
        titles: [FILE_LEVEL_TITLE],
        failures: fileFailed ? 1 : 0,
        skipped: false,
        executions: 1,
        ...(fileFailed
          ? { message: firstLine(fileResult.message) || "failed outside any test (hook or setup)" }
          : {}),
      },
    ];
  });
}

function variantOf(meta: RunMeta): string {
  return meta.name.replace(/-run\d+$/, "");
}

/** `allowEmpty` names suites where running no tests is legitimate, like `focused` with no affected tests. */
export function aggregate(
  results: RunResult[],
  expected: string[],
  allowEmpty: string[] = [],
): Report {
  const verdicts = new Map<string, TestVerdict>();
  const runProblems: RunProblem[] = [];
  const suites = new Map<string, { runs: Set<number>; executions: number; tests: Set<string> }>();
  // A Vitest process that crashes writes no report while the other commands of the run may still
  // fail normally, so each run is compared with the other runs of the same matrix variant.
  const variantReports = new Map<string, Set<string>>();
  for (const { meta, reports } of results) {
    const known = variantReports.get(variantOf(meta)) ?? new Set();
    for (const report of reports) {
      known.add(report);
    }
    variantReports.set(variantOf(meta), known);
  }

  for (const { meta, reports, cases } of results) {
    const suite = suites.get(meta.suite) ?? {
      runs: new Set(),
      executions: meta.executions,
      tests: new Set(),
    };
    suite.runs.add(meta.run);
    suites.set(meta.suite, suite);

    let sawFailure = false;
    let ranTests = 0;
    // Tests sharing a title in one file stay distinct by their order of appearance.
    const occurrences = new Map<string, number>();
    for (const testCase of cases) {
      const title = testCase.titles.join(" > ");
      const id = `${testCase.file}\0${testCase.titles.join("\0")}`;
      const occurrence = (occurrences.get(id) ?? 0) + 1;
      occurrences.set(id, occurrence);
      if (testCase.skipped) {
        continue;
      }
      const key = `${meta.suite}\0${id}\0${occurrence}`;
      if (testCase.executions === undefined) {
        ranTests += 1;
        suite.tests.add(key);
      }
      const verdict = verdicts.get(key) ?? {
        suite: meta.suite,
        file: testCase.file,
        name: occurrence === 1 ? title : `${title} (#${occurrence})`,
        runs: 0,
        failedRuns: [],
        partialRuns: 0,
      };
      verdict.runs += 1;
      if (testCase.failures > 0) {
        sawFailure = true;
        verdict.failedRuns.push(meta.run);
        // Fewer failure messages than executions proves at least one execution passed.
        if (testCase.failures < (testCase.executions ?? meta.executions)) {
          verdict.partialRuns += 1;
        }
        verdict.message ??= testCase.message;
      }
      verdicts.set(key, verdict);
    }

    const missing = [...(variantReports.get(variantOf(meta)) ?? [])]
      .filter((r) => !reports.includes(r))
      .sort();
    if (meta.exitCode === null) {
      runProblems.push({
        name: meta.name,
        problem: "test step did not run or finish (setup failure, timeout, or cancel)",
      });
    } else if (reports.length === 0) {
      runProblems.push({
        name: meta.name,
        problem: `exited ${meta.exitCode} without writing a report`,
      });
    } else if (missing.length > 0) {
      runProblems.push({ name: meta.name, problem: `no report for ${missing.join(", ")}` });
    } else if (meta.exitCode !== 0 && !sawFailure) {
      runProblems.push({
        name: meta.name,
        problem: `exited ${meta.exitCode} without a failing test (unhandled error or crash)`,
      });
    } else if (ranTests === 0 && !allowEmpty.includes(meta.suite)) {
      runProblems.push({ name: meta.name, problem: "ran no tests; check the filter" });
    }
  }

  const seen = new Set(results.map(({ meta }) => meta.name));
  for (const name of expected) {
    if (!seen.has(name)) {
      runProblems.push({ name, problem: "no results uploaded" });
    }
  }

  const failed = [...verdicts.values()]
    .filter((v) => v.failedRuns.length > 0)
    .sort(
      (a, b) =>
        b.failedRuns.length / b.runs - a.failedRuns.length / a.runs || a.file.localeCompare(b.file),
    );
  const failsEveryRun = (v: TestVerdict) => v.failedRuns.length === v.runs && v.partialRuns === 0;
  return {
    flaky: failed.filter((v) => !failsEveryRun(v)),
    failing: failed.filter(failsEveryRun),
    runProblems: runProblems.sort((a, b) => a.name.localeCompare(b.name)),
    suites: [...suites.entries()]
      .map(([suite, { runs, executions, tests }]) => ({
        suite,
        runs: runs.size,
        executions,
        tests: tests.size,
      }))
      .sort((a, b) => a.suite.localeCompare(b.suite)),
  };
}

export function isClean(report: Report): boolean {
  return (
    report.flaky.length === 0 && report.failing.length === 0 && report.runProblems.length === 0
  );
}

/** Code spans render text literally, so only table pipes and backticks need handling. */
function codeCell(value: string): string {
  return `\`${value.replaceAll("`", "'").replaceAll("|", "\\|")}\``;
}

function cell(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  const short = flat.length > MAX_MESSAGE ? `${flat.slice(0, MAX_MESSAGE)}…` : flat;
  // The empty comment keeps `@scope/name` in test titles from mentioning GitHub users or teams.
  return short.replaceAll("|", "\\|").replaceAll("<", "&lt;").replaceAll("@", "@<!---->");
}

function testTable(title: string, verdicts: TestVerdict[]): string[] {
  if (verdicts.length === 0) {
    return [];
  }
  const rows = verdicts.slice(0, MAX_ROWS).map((v) => {
    const partial = v.partialRuns > 0 ? ` (${v.partialRuns} partial)` : "";
    const runs = [...v.failedRuns].sort((a, b) => a - b).join(", ");
    return `| ${v.suite} | ${cell(v.name)} | ${codeCell(v.file)} | ${v.failedRuns.length}/${v.runs}${partial} | ${runs} | ${cell(v.message ?? "")} |`;
  });
  const lines = [
    `### ${title} (${verdicts.length})`,
    "",
    "| Suite | Test | File | Failed runs | Which runs | First failure |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ];
  if (verdicts.length > MAX_ROWS) {
    lines.push("", `…and ${verdicts.length - MAX_ROWS} more in \`report.json\`.`);
  }
  return [...lines, ""];
}

export type RenderContext = { sha: string; runUrl: string };

export function renderMarkdown(report: Report, { sha, runUrl }: RenderContext): string {
  const counts = [
    report.flaky.length > 0 ? `${report.flaky.length} flaky` : "",
    report.failing.length > 0 ? `${report.failing.length} failed in every run` : "",
    report.runProblems.length > 0 ? `${report.runProblems.length} runs without results` : "",
  ].filter(Boolean);
  const heading = isClean(report) ? "✅ no flaky tests" : `⚠️ ${counts.join(", ")}`;
  const suites = report.suites
    .map((s) =>
      s.tests === 0
        ? `${s.suite} ×${s.runs} (no tests ran)`
        : `${s.suite} ×${s.runs}${s.executions > 1 ? ` (${s.executions} executions each)` : ""}, ${s.tests} test${s.tests === 1 ? "" : "s"}`,
    )
    .join(" · ");

  const lines = [
    COMMENT_MARKER,
    `## Flaky test check: ${heading}`,
    "",
    `Commit \`${sha.slice(0, 12)}\` · ${suites || "no runs"} · [workflow run](${runUrl})`,
    "",
    ...testTable("Flaky tests", report.flaky),
    ...testTable("Failed in every run", report.failing),
  ];
  if (report.runProblems.length > 0) {
    lines.push(
      `### Runs without results (${report.runProblems.length})`,
      "",
      "| Run | Problem |",
      "| --- | --- |",
      ...report.runProblems.map((p) => `| ${codeCell(p.name)} | ${p.problem} |`),
      "",
    );
  }
  lines.push(
    "<sub>A run fails a test when any execution fails; with `--repeats`, a partial run also had passing executions, which makes the test flaky. The full data is in the `flaky-check-report` artifact.</sub>",
  );
  return `${lines.join("\n")}\n`;
}
