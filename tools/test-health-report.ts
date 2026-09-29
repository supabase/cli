/**
 * Builds the weekly test-suite health report (CLI-2541): test LOC by workspace/tier with
 * week-over-week change, the fastest-growing and slowest test files, and flaky-test signals —
 * all from git history plus the `test-*-timings-*` artifacts uploaded by `.github/workflows/test.yml`.
 * Writes to `$GITHUB_STEP_SUMMARY` when set, and always prints to stdout. Advisory only; never
 * exits non-zero for data findings, only for a tool failure.
 *
 * Usage: bun tools/test-health-report.ts [--repo owner/name] [--days 7] [--max-runs N]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  aggregateLocByWorkspaceTier,
  diffLocByWorkspaceTier,
  fastestGrowingFiles,
  flakyFiles,
  renderMarkdownReport,
  retriedJobFailures,
  slowestFiles,
  type RunAttemptJobs,
  type TestFileLoc,
  type TimingEntry,
} from "./lib/test-health-report.ts";
import { readResultEntries } from "../apps/cli/scripts/vitest-results-cache.ts";

const repoRoot = path.resolve(import.meta.dir, "..");

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(command: readonly string[]): Promise<ProcessResult> {
  const proc = Bun.spawn([...command], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runGit(args: readonly string[]): Promise<ProcessResult> {
  return run(["git", ...args]);
}

async function ghApiJson<T>(apiPath: string): Promise<T> {
  const result = await run(["gh", "api", apiPath]);
  if (result.exitCode !== 0) {
    throw new Error(`gh api ${apiPath} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as T;
}

/** Every tracked `*.test.ts` file and its line count at `ref`, via one `git grep -c` call —
 * matches a manual `git ls-files '*.test.ts' | xargs wc -l` count at that ref. */
async function listTestFilesWithLoc(ref: string): Promise<TestFileLoc[]> {
  const result = await runGit(["grep", "--no-color", "-I", "-c", "", ref, "--", "*.test.ts"]);
  // git grep exits 1 (with empty stdout) when nothing matches; that's not a tool failure.
  if (result.exitCode !== 0 && result.stdout.trim() === "") {
    if (result.exitCode === 1) {
      return [];
    }
    throw new Error(`git grep -c '' ${ref} -- '*.test.ts' failed: ${result.stderr.trim()}`);
  }
  const files: TestFileLoc[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line === "") {
      continue;
    }
    const match = /^[0-9a-f]+:(.+):(\d+)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, filePath, loc] = match;
    files.push({ path: filePath ?? "", loc: Number(loc) });
  }
  return files;
}

async function resolveWeekAgoSha(headSha: string, days: number): Promise<string> {
  const result = await runGit(["log", "-1", `--before=${days} days ago`, "--format=%H", headSha]);
  const sha = result.stdout.trim();
  return sha === "" ? headSha : sha;
}

async function commitDate(sha: string): Promise<string> {
  const result = await runGit(["log", "-1", "--format=%cs", sha]);
  return result.stdout.trim();
}

interface WorkflowRunSummary {
  readonly id: number;
  readonly html_url: string;
  readonly created_at: string;
  readonly conclusion: string | null;
  readonly run_attempt: number;
}

async function listWorkflowRuns(
  repo: string,
  event: string,
  sinceIso: string,
  branch?: string,
): Promise<WorkflowRunSummary[]> {
  const runs: WorkflowRunSummary[] = [];
  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams({
      event,
      per_page: "100",
      page: String(page),
      created: `>=${sinceIso}`,
    });
    if (branch) {
      params.set("branch", branch);
    }
    const data = await ghApiJson<{ workflow_runs: WorkflowRunSummary[] }>(
      `repos/${repo}/actions/workflows/test.yml/runs?${params.toString()}`,
    );
    runs.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) {
      break;
    }
  }
  return runs;
}

/** The week's develop pushes and merge-queue runs of the Test workflow, deduped and time-ordered. */
async function listRunsForWindow(repo: string, sinceIso: string): Promise<WorkflowRunSummary[]> {
  const [mergeQueueRuns, pushRuns] = await Promise.all([
    listWorkflowRuns(repo, "merge_group", sinceIso),
    listWorkflowRuns(repo, "push", sinceIso, "develop"),
  ]);
  const byId = new Map<number, WorkflowRunSummary>();
  for (const run of [...mergeQueueRuns, ...pushRuns]) {
    byId.set(run.id, run);
  }
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Downloads a run's `*-timings-*` artifacts into `destDir`; returns false when the run has none
 * (e.g. it was cancelled before the upload step), which is not a failure. */
async function downloadTimingArtifacts(
  repo: string,
  runId: number,
  destDir: string,
): Promise<boolean> {
  const result = await run([
    "gh",
    "run",
    "download",
    String(runId),
    "--repo",
    repo,
    "--pattern",
    "*-timings-*",
    "--dir",
    destDir,
  ]);
  if (result.exitCode !== 0) {
    if (!/no artifacts? found|no valid artifacts/i.test(result.stderr)) {
      console.warn(`[test-health-report] gh run download ${runId} failed: ${result.stderr.trim()}`);
    }
    return false;
  }
  return true;
}

async function attempt1Jobs(
  repo: string,
  runId: number,
): Promise<ReadonlyArray<{ readonly name: string; readonly conclusion: string | null }>> {
  const data = await ghApiJson<{ jobs: Array<{ name: string; conclusion: string | null }> }>(
    `repos/${repo}/actions/runs/${runId}/attempts/1/jobs`,
  );
  return data.jobs.map((job) => ({ name: job.name, conclusion: job.conclusion }));
}

async function writeStepSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  await Bun.write(summaryPath, `${markdown}\n`, { createPath: true });
}

const usage = `Usage: bun tools/test-health-report.ts [--repo owner/name] [--days 7] [--max-runs N]

  Builds the weekly test-suite health report from git history and the week's
  develop/merge-queue Test workflow run artifacts. --max-runs caps how many
  matching runs are downloaded, for local dry runs or rate-limit safety.`;

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string", default: "supabase/cli" },
      days: { type: "string", default: "7" },
      "max-runs": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(usage);
    process.exit(0);
  }

  const repo = values.repo ?? "supabase/cli";
  const days = Number(values.days ?? "7");
  const maxRuns = values["max-runs"] !== undefined ? Number(values["max-runs"]) : undefined;
  const notes: string[] = [];

  try {
    const headSha = (await runGit(["rev-parse", "HEAD"])).stdout.trim();
    const weekAgoSha = await resolveWeekAgoSha(headSha, days);
    const weekAgoDate = await commitDate(weekAgoSha);

    const [currentFiles, previousFiles] = await Promise.all([
      listTestFilesWithLoc(headSha),
      listTestFilesWithLoc(weekAgoSha),
    ]);
    const locChanges = diffLocByWorkspaceTier(
      aggregateLocByWorkspaceTier(currentFiles),
      aggregateLocByWorkspaceTier(previousFiles),
    );
    const fastestGrowing = fastestGrowingFiles(currentFiles, previousFiles);

    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    let runs = await listRunsForWindow(repo, sinceIso);
    if (maxRuns !== undefined && runs.length > maxRuns) {
      notes.push(
        `sampled the ${maxRuns} most recent of ${runs.length} matching runs from the past ` +
          `${days} day(s) (--max-runs).`,
      );
      runs = runs.slice(-maxRuns);
    }

    const timingEntries: TimingEntry[] = [];
    const runAttemptInfos: RunAttemptJobs[] = [];
    const downloadRoot = mkdtempSync(join(tmpdir(), "test-health-report-"));
    try {
      for (const workflowRun of runs) {
        const runDir = join(downloadRoot, String(workflowRun.id));
        if (await downloadTimingArtifacts(repo, workflowRun.id, runDir)) {
          try {
            timingEntries.push(...readResultEntries(runDir));
          } catch (cause) {
            console.warn(
              `[test-health-report] could not parse timing artifacts for run ${workflowRun.id}: ` +
                `${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }

        if (workflowRun.run_attempt > 1) {
          runAttemptInfos.push({
            runId: workflowRun.id,
            runUrl: workflowRun.html_url,
            finalAttempt: workflowRun.run_attempt,
            finalConclusion: workflowRun.conclusion,
            attempt1Jobs: await attempt1Jobs(repo, workflowRun.id),
          });
        }
      }
    } finally {
      rmSync(downloadRoot, { recursive: true, force: true });
    }

    if (timingEntries.length === 0 && runs.length > 0) {
      notes.push(
        "no timing artifacts were found for this week's runs — unit/integration timing uploads " +
          "only exist once this report's own workflow changes have merged; only e2e timings are " +
          "available until then.",
      );
    } else if (timingEntries.some((entry) => entry.workspace === ".")) {
      notes.push(
        'some timing entries show workspace "." — they came from an e2e-timings artifact ' +
          "uploaded before the per-workspace staging step landed, so their workspace could not " +
          "be recovered.",
      );
    }

    const markdown = renderMarkdownReport({
      metadata: { headSha, weekAgoSha, weekAgoDate, runsAnalyzed: runs.length, notes },
      locChanges,
      fastestGrowing,
      slowest: slowestFiles(timingEntries),
      flakyFiles: flakyFiles(timingEntries),
      retriedJobFailures: retriedJobFailures(runAttemptInfos),
    });

    console.log(markdown);
    await writeStepSummary(markdown);
  } catch (cause) {
    console.error(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  }
}
