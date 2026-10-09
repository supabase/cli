import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { JsonTestResults } from "vitest/node";
import {
  CheckError,
  collectedName,
  commandsFor,
  type Entry,
  plan,
  RESULTS_DIR,
  type ReportSource,
} from "./plan.ts";
import {
  aggregate,
  COMMENT_MARKER,
  isClean,
  parseVitestJson,
  renderMarkdown,
  type RunMeta,
  type RunResult,
} from "./report.ts";

function env(name: string): string {
  return process.env[name] ?? "";
}

function setOutputs(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`);
  appendFileSync(env("GITHUB_OUTPUT") || "/dev/stdout", lines.join(""));
}

function capture(argv: string[]): string {
  const result = Bun.spawnSync(argv, { stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new CheckError(`${argv.join(" ")} exited ${result.exitCode}`);
  }
  return result.stdout.toString().trim();
}

function words(value: string): string[] {
  return value.split(/\s+/).filter((word) => word !== "");
}

function planCommand(): void {
  const { entries, base, filter } = plan({
    event: env("EVENT_NAME"),
    schedule: env("SCHEDULE"),
    baseRef: env("PR_BASE_REF"),
    suites: env("INPUT_SUITES"),
    runs: env("INPUT_RUNS"),
    repeats: env("INPUT_REPEATS"),
    filter: env("INPUT_FILTER"),
  });
  // github.sha is already the commit to test (a PR's merge commit, or the branch head), unless a
  // dispatch names another ref.
  const ref = env("INPUT_REF");
  const sha =
    ref === ""
      ? env("EVENT_SHA")
      : capture([
          "gh",
          "api",
          `repos/${env("GITHUB_REPOSITORY")}/commits/${encodeURIComponent(ref)}`,
          "--jq",
          ".sha",
        ]);
  setOutputs({ sha, base, filter, matrix: JSON.stringify({ include: entries }) });
}

type TurboTask = { task: string; package: string; directory: string; command: string };

/** Collected report names an invocation should produce, so a report that never appears is flagged. */
function expectedReports(source: ReportSource, turboCache: Map<string, TurboTask[]>): string[] {
  if ("dir" in source) {
    return [collectedName(source.dir, source.report)];
  }
  const key = source.turbo.join(" ");
  let tasks = turboCache.get(key);
  if (tasks === undefined) {
    const dryRun: { tasks: TurboTask[] } = JSON.parse(
      capture(["pnpm", "exec", "turbo", "run", ...source.turbo, "--dry=json"]),
    );
    tasks = dryRun.tasks.filter(
      (task) => task.task === source.turbo[0] && task.command !== "<NONEXISTENT>",
    );
    turboCache.set(key, tasks);
  }
  return tasks.map((task) => {
    // Turbo forwards arguments to the last command of a chained script only.
    if (task.command.includes("&&")) {
      throw new CheckError(
        `${task.package} chains commands in ${task.task}, so only its last one would write a report`,
      );
    }
    return collectedName(task.directory, source.report);
  });
}

async function runCommand(): Promise<number> {
  const entry: Entry = JSON.parse(env("MATRIX"));
  const filters = words(env("FILTER"));
  const extra =
    entry.suite === "focused" && filters.length === 0
      ? ["--changed", capture(["git", "merge-base", "HEAD", `origin/${env("BASE_REF")}`])]
      : filters;
  if (entry.suite === "e2e") {
    process.env.SUPABASE_GO_BINARY = join(process.cwd(), "apps/cli-go/supabase-go");
  }
  let exitCode = 0;
  const expected: string[] = [];
  const turboCache = new Map<string, TurboTask[]>();
  for (let iteration = 1; iteration <= entry.executions; iteration += 1) {
    for (const { argv, reports } of commandsFor(entry, iteration, extra)) {
      expected.push(...expectedReports(reports, turboCache));
      console.log(`$ ${argv.join(" ")}`);
      const code = await Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" }).exited;
      exitCode = code === 0 ? exitCode : code;
    }
  }
  setOutputs({ "exit-code": String(exitCode), "expected-reports": JSON.stringify(expected) });
  return exitCode;
}

function collectCommand(): void {
  const entry: Entry = JSON.parse(env("MATRIX"));
  const out = join(env("RUNNER_TEMP"), "flaky-results", entry.name);
  mkdirSync(out, { recursive: true });
  for (const report of new Bun.Glob(`{apps,packages}/*/${RESULTS_DIR}/*.json`).scanSync({
    dot: true,
  })) {
    copyFileSync(
      report,
      join(out, collectedName(dirname(dirname(report)), basename(report, ".json"))),
    );
  }
  const meta: RunMeta = {
    name: entry.name,
    suite: entry.suite,
    run: entry.run,
    executions: entry.executions,
    exitCode: env("EXIT_CODE") === "" ? null : Number(env("EXIT_CODE")),
    root: process.cwd(),
    expectedReports: JSON.parse(env("EXPECTED_REPORTS") || "[]"),
  };
  writeFileSync(join(out, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  setOutputs({ dir: out });
}

/** A missing, truncated, or foreign report reads as absent, which the aggregation flags. */
function readReport(path: string): JsonTestResults | undefined {
  try {
    const results: JsonTestResults = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(results?.testResults) ? results : undefined;
  } catch {
    return undefined;
  }
}

function readResults(dir: string): RunResult[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "meta.json")))
    .map((name) => {
      const runDir = join(dir, name);
      const meta: RunMeta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
      const reports = readdirSync(runDir)
        .filter((file) => file.endsWith(".json") && file !== "meta.json")
        .flatMap((file) => {
          const results = readReport(join(runDir, file));
          const iteration = Number(/\.(\d+)\.json$/.exec(file)?.[1] ?? "1");
          return results === undefined
            ? []
            : [{ name: file, iteration, cases: parseVitestJson(results, meta.root) }];
        });
      return { meta, reports };
    });
}

function reportCommand(): void {
  const [resultsDir = "results", outDir = "flaky-report"] = process.argv.slice(3);
  const matrix: { include: Entry[] } = JSON.parse(env("MATRIX") || '{"include":[]}');
  const report = aggregate(
    readResults(resultsDir),
    matrix.include.map((entry) => entry.name),
    env("FILTER") === "" ? ["focused"] : [],
  );
  const markdown = renderMarkdown(report, {
    sha: env("SHA"),
    runUrl: `${env("GITHUB_SERVER_URL")}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}`,
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "report.md"), markdown);
  appendFileSync(env("GITHUB_STEP_SUMMARY") || "/dev/stdout", markdown);
  if (!isClean(report)) {
    console.log(
      "::error ::Flaky, failing, or missing runs found; see the job summary or the flaky-check-report artifact.",
    );
    process.exitCode = 1;
  }
}

/** Creates or updates the one PR comment that starts with the report marker. */
function commentCommand(): void {
  const [reportPath = "flaky-report/report.md"] = process.argv.slice(3);
  const issue = `repos/${env("GITHUB_REPOSITORY")}/issues`;
  try {
    const pages: { id: number; body: string; user: { login: string } }[][] = JSON.parse(
      capture(["gh", "api", "--paginate", "--slurp", `${issue}/${env("PR_NUMBER")}/comments`]),
    );
    const existing = pages
      .flat()
      .find(
        (comment) =>
          comment.user.login === "github-actions[bot]" && comment.body.startsWith(COMMENT_MARKER),
      );
    const target =
      existing === undefined
        ? ["POST", `${issue}/${env("PR_NUMBER")}/comments`]
        : ["PATCH", `${issue}/comments/${existing.id}`];
    capture(["gh", "api", "--method", ...target, "--field", `body=@${reportPath}`]);
  } catch (error) {
    // The report stays in the job summary and artifact, so a comment failure only warns.
    console.log(
      `::warning::Unable to post the flaky-check PR comment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (import.meta.main) {
  const command = process.argv[2];
  try {
    switch (command) {
      case "plan":
        planCommand();
        break;
      case "run":
        process.exitCode = await runCommand();
        break;
      case "collect":
        collectCommand();
        break;
      case "report":
        reportCommand();
        break;
      case "comment":
        commentCommand();
        break;
      default:
        throw new CheckError(
          `usage: cli.ts plan|run|collect|report|comment, got '${command ?? ""}'`,
        );
    }
  } catch (error) {
    if (!(error instanceof CheckError)) {
      throw error;
    }
    console.log(`::error ::${error.message}`);
    process.exitCode = 1;
  }
}
