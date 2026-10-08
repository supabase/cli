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
  /** Executions of the suite in this run, each a separate Vitest process. */
  executions: number;
  /** `null` when the test step did not run or finish, such as after a setup failure or timeout. */
  exitCode: number | null;
  /** Checkout root the reports' absolute file paths are relative to. */
  root: string;
  /** Collected report names the run's invocations were expected to write. */
  expectedReports: string[];
};

export type TestCase = {
  file: string;
  titles: string[];
  failed: boolean;
  skipped: boolean;
  /** File-level entries record `beforeAll` and import failures, which no test entry carries. */
  fileLevel: boolean;
  message?: string;
};

/** One Vitest JSON report; `iteration` tells executions within a run apart. */
type CollectedReport = { name: string; iteration: number; cases: TestCase[] };

export type RunResult = { meta: RunMeta; reports: CollectedReport[] };

type Execution = { run: number; iteration: number };

type TestVerdict = {
  suite: string;
  file: string;
  name: string;
  executions: number;
  failedIn: Execution[];
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
 * Flattens one Vitest JSON report of a single execution. Each file also gets a file-level entry,
 * because a failing `beforeAll` or import only marks the file failed.
 */
export function parseVitestJson(results: JsonTestResults, root: string): TestCase[] {
  return results.testResults.flatMap((fileResult) => {
    const file = relative(root, fileResult.name);
    const tests = fileResult.assertionResults.map((assertion): TestCase => {
      const message = assertion.failureMessages?.[0];
      return {
        file,
        titles: [...assertion.ancestorTitles, assertion.title],
        failed: assertion.status === "failed",
        skipped: SKIPPED.has(assertion.status),
        fileLevel: false,
        ...(message === undefined ? {} : { message: firstLine(message) }),
      };
    });
    // With failing tests and an empty message, the file status says nothing more about hooks.
    const fileFailed =
      fileResult.status === "failed" &&
      (fileResult.message !== "" || !tests.some((test) => test.failed));
    const fileLevel: TestCase = {
      file,
      titles: [FILE_LEVEL_TITLE],
      failed: fileFailed,
      skipped: false,
      fileLevel: true,
      ...(fileFailed
        ? { message: firstLine(fileResult.message) || "failed outside any test (hook or setup)" }
        : {}),
    };
    return [...tests, fileLevel];
  });
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

  for (const { meta, reports } of results) {
    const suite = suites.get(meta.suite) ?? {
      runs: new Set(),
      executions: meta.executions,
      tests: new Set(),
    };
    suite.runs.add(meta.run);
    suites.set(meta.suite, suite);

    let sawFailure = false;
    let ranTests = 0;
    const iterations = [...new Set(reports.map((report) => report.iteration))].sort(
      (a, b) => a - b,
    );
    for (const iteration of iterations) {
      // Tests sharing a title in one file stay distinct by their order of appearance.
      const occurrences = new Map<string, number>();
      const cases = reports
        .filter((report) => report.iteration === iteration)
        .flatMap((report) => report.cases);
      for (const testCase of cases) {
        const id = `${testCase.file}\0${testCase.titles.join("\0")}`;
        const occurrence = (occurrences.get(id) ?? 0) + 1;
        occurrences.set(id, occurrence);
        if (testCase.skipped) {
          continue;
        }
        const key = `${meta.suite}\0${id}\0${occurrence}`;
        if (!testCase.fileLevel) {
          ranTests += 1;
          suite.tests.add(key);
        }
        const title = testCase.titles.join(" > ");
        const verdict = verdicts.get(key) ?? {
          suite: meta.suite,
          file: testCase.file,
          name: occurrence === 1 ? title : `${title} (#${occurrence})`,
          executions: 0,
          failedIn: [],
        };
        verdict.executions += 1;
        if (testCase.failed) {
          sawFailure = true;
          verdict.failedIn.push({ run: meta.run, iteration });
          verdict.message ??= testCase.message;
        }
        verdicts.set(key, verdict);
      }
    }

    const collected = new Set(reports.map((report) => report.name));
    const missing = meta.expectedReports.filter((name) => !collected.has(name)).sort();
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
    .filter((v) => v.failedIn.length > 0)
    .sort(
      (a, b) =>
        b.failedIn.length / b.executions - a.failedIn.length / a.executions ||
        a.file.localeCompare(b.file),
    );
  const failsEveryExecution = (v: TestVerdict) => v.failedIn.length === v.executions;
  return {
    flaky: failed.filter((v) => !failsEveryExecution(v)),
    failing: failed.filter(failsEveryExecution),
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

function where(executions: Execution[], repeated: boolean): string {
  return [...executions]
    .sort((a, b) => a.run - b.run || a.iteration - b.iteration)
    .map((e) => (repeated ? `${e.run}.${e.iteration}` : `${e.run}`))
    .join(", ");
}

function testTable(title: string, verdicts: TestVerdict[], repeated: Set<string>): string[] {
  if (verdicts.length === 0) {
    return [];
  }
  const rows = verdicts
    .slice(0, MAX_ROWS)
    .map(
      (v) =>
        `| ${v.suite} | ${cell(v.name)} | ${codeCell(v.file)} | ${v.failedIn.length}/${v.executions} | ${where(v.failedIn, repeated.has(v.suite))} | ${cell(v.message ?? "")} |`,
    );
  const lines = [
    `### ${title} (${verdicts.length})`,
    "",
    "| Suite | Test | File | Failed | Where | First failure |",
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
    report.failing.length > 0 ? `${report.failing.length} failed every time` : "",
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
  const repeated = new Set(report.suites.filter((s) => s.executions > 1).map((s) => s.suite));

  const lines = [
    COMMENT_MARKER,
    `## Flaky test check: ${heading}`,
    "",
    `Commit \`${sha.slice(0, 12)}\` · ${suites || "no runs"} · [workflow run](${runUrl})`,
    "",
    ...testTable("Flaky tests", report.flaky, repeated),
    ...testTable("Failed every time", report.failing, repeated),
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
    "<sub>Each execution is a separate Vitest process; `Where` lists failing runs, as `run.iteration` for suites executed more than once per run. The full data is in the `flaky-check-report` artifact.</sub>",
  );
  return `${lines.join("\n")}\n`;
}
