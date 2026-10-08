import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const COMMENT_MARKER = "<!-- flaky-check -->";
const MAX_ROWS = 50;
const MAX_MESSAGE = 200;

/** What one matrix job recorded next to its JUnit files in `meta.json`. */
export type RunMeta = {
  name: string;
  suite: string;
  run: number;
  /** Executions of each test in this run: 1, or `--repeats` + 1. */
  executions: number;
  /** `null` when the test step never finished, such as on a timeout or cancel. */
  exitCode: number | null;
};

export type TestCase = {
  pkg: string;
  file: string;
  name: string;
  failures: number;
  skipped: boolean;
  message?: string;
};

/** `reports` names the JUnit files the run produced, one per workspace package that ran. */
export type RunResult = { meta: RunMeta; reports: string[]; cases: TestCase[] };

export type TestVerdict = {
  suite: string;
  file: string;
  name: string;
  runs: number;
  failedRuns: number[];
  /** Failed runs in which other executions of the test passed (only possible with `--repeats`). */
  partialRuns: number;
  message?: string;
};

export type RunProblem = { name: string; problem: string };

export type Report = {
  flaky: TestVerdict[];
  failing: TestVerdict[];
  runProblems: RunProblem[];
  suites: { suite: string; runs: number; executions: number; tests: number }[];
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (!entity.startsWith("#")) {
      return ENTITIES[entity] ?? match;
    }
    const hex = entity[1] === "x" || entity[1] === "X";
    const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  });
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match?.[1] === undefined ? undefined : unescapeXml(match[1]);
}

/**
 * Parses Vitest's JUnit output. Each error adds a `<failure>` element, so one failed execution
 * can contribute several (a failing test and its failing `afterEach`, for example).
 */
export function parseJunit(xml: string, pkg: string): TestCase[] {
  const cases: TestCase[] = [];
  const testcase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcase)) {
    const tag = match[1] ?? "";
    const body = match[3] ?? "";
    const failureTags = [...body.matchAll(/<(failure|error)\b([^>]*)>/g)];
    const message =
      failureTags[0] === undefined ? undefined : attribute(failureTags[0][2] ?? "", "message");
    cases.push({
      pkg,
      file: attribute(tag, "classname") ?? "",
      name: attribute(tag, "name") ?? "",
      failures: failureTags.length,
      skipped: /<skipped\b/.test(body),
      ...(message === undefined ? {} : { message }),
    });
  }
  return cases;
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
  // A package whose Vitest process crashes writes no report while the rest of the Turbo run may
  // still fail normally, so each run is compared with the other runs of the same matrix variant.
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
    // Tests sharing a title in one file stay distinct by their order of appearance.
    const occurrences = new Map<string, number>();
    for (const testCase of cases) {
      const file = `${testCase.pkg}/${testCase.file}`;
      const occurrence = (occurrences.get(`${file}\0${testCase.name}`) ?? 0) + 1;
      occurrences.set(`${file}\0${testCase.name}`, occurrence);
      if (testCase.skipped) {
        continue;
      }
      const name = occurrence === 1 ? testCase.name : `${testCase.name} (#${occurrence})`;
      const key = `${meta.suite}\0${file}\0${testCase.name}\0${occurrence}`;
      suite.tests.add(key);
      const verdict = verdicts.get(key) ?? {
        suite: meta.suite,
        file,
        name,
        runs: 0,
        failedRuns: [],
        partialRuns: 0,
      };
      verdict.runs += 1;
      if (testCase.failures > 0) {
        sawFailure = true;
        verdict.failedRuns.push(meta.run);
        // Fewer error elements than executions proves at least one execution passed.
        if (testCase.failures < meta.executions) {
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
        problem: `exited ${meta.exitCode} without writing a JUnit report`,
      });
    } else if (missing.length > 0) {
      runProblems.push({ name: meta.name, problem: `no JUnit report for ${missing.join(", ")}` });
    } else if (meta.exitCode !== 0 && !sawFailure) {
      runProblems.push({
        name: meta.name,
        problem: `exited ${meta.exitCode} without a failing test (setup, unhandled error, or crash)`,
      });
    }
  }

  for (const [name, { tests }] of suites) {
    if (tests.size === 0 && !allowEmpty.includes(name)) {
      runProblems.push({ name: `${name} (every run)`, problem: "no tests ran; check the filter" });
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
  const alwaysFails = (v: TestVerdict) => v.failedRuns.length === v.runs && v.partialRuns === 0;
  return {
    flaky: failed.filter((v) => !alwaysFails(v)),
    failing: failed.filter(alwaysFails),
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
  const lines = [
    `### ${title} (${verdicts.length})`,
    "",
    "| Suite | Test | File | Failed runs | Which runs | First failure |",
    "| --- | --- | --- | --- | --- | --- |",
    ...verdicts
      .slice(0, MAX_ROWS)
      .map(
        (v) =>
          `| ${v.suite} | ${cell(v.name)} | \`${cell(v.file)}\` | ${v.failedRuns.length}/${v.runs}${v.partialRuns > 0 ? ` (${v.partialRuns} partial)` : ""} | ${[...v.failedRuns].sort((a, b) => a - b).join(", ")} | ${cell(v.message ?? "")} |`,
      ),
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
      ...report.runProblems.map((p) => `| \`${p.name}\` | ${p.problem} |`),
      "",
    );
  }
  lines.push(
    "<sub>A run fails a test when any execution fails; with `--repeats`, a partial run also had passing executions, which makes the test flaky. The full data is in the `flaky-check-report` artifact.</sub>",
  );
  return `${lines.join("\n")}\n`;
}

function readResults(dir: string): RunResult[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "meta.json")))
    .map((entry) => {
      const runDir = join(dir, entry.name);
      const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as RunMeta;
      const reports = readdirSync(runDir).filter((file) => file.endsWith(".xml"));
      const cases = reports.flatMap((file) => {
        // Files are named `<package path with / as __>--<suite>.xml` by the collect action.
        const pkg = file.split("--")[0]?.replaceAll("__", "/") ?? "";
        return parseJunit(readFileSync(join(runDir, file), "utf8"), pkg);
      });
      return { meta, reports, cases };
    });
}

if (import.meta.main) {
  const [resultsDir = "results", outDir = "flaky-report"] = process.argv.slice(2);
  const expected = JSON.parse(process.env.EXPECTED ?? "[]") as string[];
  const results = existsSync(resultsDir) ? readResults(resultsDir) : [];
  const report = aggregate(results, expected, process.env.FILTER ? [] : ["focused"]);
  const markdown = renderMarkdown(report, {
    sha: process.env.SHA ?? "",
    runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "report.md"), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: "a" });
  }
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `clean=${isClean(report)}\n`, { flag: "a" });
  }
  console.log(markdown);
}
