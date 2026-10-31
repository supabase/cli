/**
 * CLI benchmark resolver for `pull_request` runs: decides whether the benchmark job runs.
 *
 * The first run on a pull request benchmarks and comments. Later pushes skip while the
 * lightweight comment exists and reports a result; a re-run (`run_attempt` above 1), a missing
 * comment, a failed first run, or a fork pull request, which never has a comment, benchmarks.
 * Needs read access only.
 * Run in CI as: `bun .github/scripts/cli-bench/resolve.ts`.
 */
import { appendFileSync } from "node:fs";

import { listIssueComments, requireEnv, type IssueComment } from "./github.ts";
import { commentFailed, findComment } from "./post-comment.ts";

export interface ResolveInput {
  runAttempt: number;
  isFork: boolean;
  comments: ReadonlyArray<IssueComment>;
}

export interface ResolveResult {
  shouldRun: boolean;
  /** Shown in the job summary when the benchmark is skipped. */
  skipReason?: string;
}

export const SKIP_REASON =
  "A benchmark comment already exists on this pull request. Comment `/bench` to refresh it.";

/** Skips only a first attempt on a pull request whose benchmark comment reports a result. */
export function resolveBench(input: ResolveInput): ResolveResult {
  if (input.isFork || input.runAttempt > 1) return { shouldRun: true };
  const existing = findComment("lightweight", input.comments);
  if (existing === undefined || commentFailed(existing.body)) return { shouldRun: true };
  return { shouldRun: false, skipReason: SKIP_REASON };
}

async function main(): Promise<void> {
  const token = requireEnv("GITHUB_TOKEN");
  const base = `https://api.github.com/repos/${requireEnv("GITHUB_REPOSITORY")}`;
  const prNumber = Number(requireEnv("PR_NUMBER"));
  const runAttempt = Number(requireEnv("RUN_ATTEMPT"));
  const isFork = requireEnv("HEAD_REPO") !== requireEnv("GITHUB_REPOSITORY");

  let comments: ReadonlyArray<IssueComment> = [];
  if (!isFork && runAttempt === 1) {
    // A comment that cannot be listed must not hide a benchmark: run it instead.
    comments = await listIssueComments(token, base, prNumber).catch((error: unknown) => {
      console.warn(`Could not list comments on PR #${prNumber}: ${String(error)}`);
      return [];
    });
  }

  const result = resolveBench({ runAttempt, isFork, comments });
  console.log(
    `CLI benchmark resolve for PR #${prNumber}: should_run=${result.shouldRun} ` +
      `attempt=${runAttempt} fork=${isFork}`,
  );
  appendFileSync(requireEnv("GITHUB_OUTPUT"), `should_run=${result.shouldRun}\n`);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (result.skipReason && summaryFile) appendFileSync(summaryFile, `${result.skipReason}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
