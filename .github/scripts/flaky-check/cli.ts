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
import { commandsFor, RESULTS_DIR, type RunSpec } from "./commands.ts";
import { matrix, plan, PlanError, type PlanInput } from "./plan.ts";
import {
  aggregate,
  COMMENT_MARKER,
  isClean,
  parseVitestJson,
  renderMarkdown,
  type RunMeta,
  type RunResult,
} from "./report.ts";

class CliError extends Error {}

function env(name: string): string {
  return process.env[name] ?? "";
}

function setOutputs(values: Record<string, string>): void {
  const file = env("GITHUB_OUTPUT");
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`);
  if (file === "") {
    process.stdout.write(lines.join(""));
  } else {
    appendFileSync(file, lines.join(""));
  }
}

function appendSummary(markdown: string): void {
  if (env("GITHUB_STEP_SUMMARY") !== "") {
    appendFileSync(env("GITHUB_STEP_SUMMARY"), markdown);
  }
}

function capture(argv: string[]): string {
  const result = Bun.spawnSync(argv, { stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new CliError(`${argv.join(" ")} exited ${result.exitCode}`);
  }
  return result.stdout.toString().trim();
}

function oneOf<const T extends string>(value: string, allowed: readonly T[], label: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new CliError(`${label} must be one of ${allowed.join(", ")}, got '${value}'`);
  }
  return match;
}

function words(value: string): string[] {
  return value.split(/\s+/).filter((word) => word !== "");
}

function planCommand(): void {
  const event = env("EVENT_NAME");
  let input: PlanInput;
  let ref: string | undefined;
  switch (event) {
    case "schedule":
      input = { event, schedule: env("SCHEDULE") };
      ref = "develop";
      break;
    case "pull_request":
      input = { event, baseRef: env("PR_BASE_REF") };
      break;
    case "workflow_dispatch":
      input = {
        event,
        suites: env("INPUT_SUITES"),
        runs: env("INPUT_RUNS"),
        repeats: env("INPUT_REPEATS"),
        filter: env("INPUT_FILTER"),
      };
      ref = env("INPUT_REF") || env("GITHUB_REF_NAME");
      break;
    default:
      throw new PlanError(`unsupported event '${event}'`);
  }
  const result = plan(input);
  // A pull request tests its merge commit, the same commit the Test workflow checks.
  const sha =
    ref === undefined
      ? env("EVENT_SHA")
      : capture([
          "gh",
          "api",
          `repos/${env("GITHUB_REPOSITORY")}/commits/${encodeURIComponent(ref)}`,
          "--jq",
          ".sha",
        ]);

  setOutputs({
    sha,
    base: result.base,
    repeats: String(result.repeats),
    filter: result.filter,
    tests: matrix(result.tests),
    e2e: matrix(result.e2e),
    stack: matrix(result.stack),
    expected: JSON.stringify(result.expected),
  });
  appendSummary(
    `### Flaky check plan\n\nCommit \`${sha}\`, suites \`${result.suites.join(",")}\`, ${result.runs} runs each, focused repeats ${result.repeats}, base \`${result.base}\`.\n`,
  );
}

function runSpec(): RunSpec {
  const suite = env("SUITE");
  switch (suite) {
    case "unit":
    case "integration":
      return { suite, filters: words(env("FILTER")) };
    case "focused": {
      const filters = words(env("FILTER"));
      if (filters.length > 0) {
        return { suite, repeats: Number(env("REPEATS")), selection: { filters } };
      }
      const base = env("BASE_REF");
      const changedSince = capture(["git", "merge-base", "HEAD", `origin/${base}`]);
      return { suite, repeats: Number(env("REPEATS")), selection: { changedSince } };
    }
    case "e2e":
      return {
        suite,
        target: oneOf(env("TARGET"), ["cli", "cli-e2e"], "TARGET"),
        shard: Number(env("SHARD")),
      };
    case "stack-e2e":
      return {
        suite,
        runtime: oneOf(env("RUNTIME"), ["native", "docker", "podman"], "RUNTIME"),
        scenario: oneOf(env("SCENARIO"), ["lifecycle", "idle-parallel"], "SCENARIO"),
      };
    default:
      throw new CliError(`unknown suite '${suite}'`);
  }
}

async function runCommand(): Promise<number> {
  let exitCode = 0;
  try {
    for (const argv of commandsFor(runSpec())) {
      console.log(`$ ${argv.join(" ")}`);
      const code = await Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" }).exited;
      if (code !== 0) {
        exitCode = code;
      }
    }
  } catch (error) {
    console.log(`::error ::${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
  setOutputs({ "exit-code": String(exitCode) });
  return exitCode;
}

function collectCommand(): void {
  const name = env("NAME");
  const out = join(env("RUNNER_TEMP"), "flaky-results", name);
  mkdirSync(out, { recursive: true });
  const reports = new Bun.Glob(`{apps,packages}/*/${RESULTS_DIR}/*.json`).scanSync({ dot: true });
  for (const report of reports) {
    // `apps/cli/.flaky-results/unit.json` becomes `apps__cli--unit.json`.
    const pkg = dirname(dirname(report)).replaceAll("/", "__");
    copyFileSync(report, join(out, `${pkg}--${basename(report)}`));
  }
  const meta: RunMeta = {
    name,
    suite: env("SUITE"),
    run: Number(env("RUN")),
    executions: Number(env("EXECUTIONS") || "1"),
    exitCode: env("EXIT_CODE") === "" ? null : Number(env("EXIT_CODE")),
    root: process.cwd(),
  };
  writeFileSync(join(out, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  setOutputs({ dir: out });
  console.log(readdirSync(out).join("\n"));
}

function isRunMeta(value: unknown): value is RunMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "suite" in value &&
    typeof value.suite === "string" &&
    "run" in value &&
    typeof value.run === "number" &&
    "executions" in value &&
    typeof value.executions === "number" &&
    "exitCode" in value &&
    (value.exitCode === null || typeof value.exitCode === "number") &&
    "root" in value &&
    typeof value.root === "string"
  );
}

function isVitestJson(value: unknown): value is JsonTestResults {
  return (
    typeof value === "object" &&
    value !== null &&
    "testResults" in value &&
    Array.isArray(value.testResults)
  );
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readResults(dir: string): RunResult[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const runDir = join(dir, entry.name);
    const meta = entry.isDirectory() ? readJson(join(runDir, "meta.json")) : undefined;
    if (!isRunMeta(meta)) {
      return [];
    }
    const reports: string[] = [];
    const cases = readdirSync(runDir)
      .filter((file) => file.endsWith(".json") && file !== "meta.json")
      .flatMap((file) => {
        // An unreadable report counts as missing, which the aggregation flags.
        const results = readJson(join(runDir, file));
        if (!isVitestJson(results)) {
          return [];
        }
        reports.push(file);
        return parseVitestJson(results, meta.root);
      });
    return [{ meta, reports, cases }];
  });
}

function reportCommand(): void {
  const [resultsDir = "results", outDir = "flaky-report"] = process.argv.slice(3);
  const expected: unknown = JSON.parse(env("EXPECTED") || "[]");
  const report = aggregate(
    readResults(resultsDir),
    Array.isArray(expected) ? expected.map(String) : [],
    env("FILTER") === "" ? ["focused"] : [],
  );
  const markdown = renderMarkdown(report, {
    sha: env("SHA"),
    runUrl: `${env("GITHUB_SERVER_URL")}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}`,
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "report.md"), markdown);
  appendSummary(markdown);
  setOutputs({ clean: String(isClean(report)) });
  console.log(markdown);
}

function isComment(value: unknown): value is { id: number; body: string; user: { login: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    "body" in value &&
    typeof value.body === "string" &&
    "user" in value &&
    typeof value.user === "object" &&
    value.user !== null &&
    "login" in value.user
  );
}

/** Creates or updates the one PR comment that starts with the report marker. */
function commentCommand(): void {
  const [reportPath = "flaky-report/report.md"] = process.argv.slice(3);
  const issue = `repos/${env("GITHUB_REPOSITORY")}/issues`;
  try {
    const pages: unknown = JSON.parse(
      capture(["gh", "api", "--paginate", "--slurp", `${issue}/${env("PR_NUMBER")}/comments`]),
    );
    const existing = (Array.isArray(pages) ? pages.flat() : [])
      .filter(isComment)
      .find(
        (comment) =>
          comment.user.login === "github-actions[bot]" && comment.body.startsWith(COMMENT_MARKER),
      );
    const body = `body=@${reportPath}`;
    if (existing === undefined) {
      capture([
        "gh",
        "api",
        "--method",
        "POST",
        `${issue}/${env("PR_NUMBER")}/comments`,
        "--field",
        body,
      ]);
    } else {
      capture([
        "gh",
        "api",
        "--method",
        "PATCH",
        `${issue}/comments/${existing.id}`,
        "--field",
        body,
      ]);
    }
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
        process.exit(await runCommand());
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
        throw new CliError(`usage: cli.ts plan|run|collect|report|comment, got '${command ?? ""}'`);
    }
  } catch (error) {
    if (!(error instanceof PlanError || error instanceof CliError)) {
      throw error;
    }
    console.log(`::error ::${error.message}`);
    process.exit(1);
  }
}
