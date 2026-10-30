/**
 * `/bench` and `/bench full` handler.
 *
 * Runs default branch code and never checks out or runs pull request code. The commenter must be
 * the repository owner or hold write access, and the pull request must be an open, ready one from
 * this repository into `develop`. `/bench` re-runs the existing `pull_request` run, which
 * benchmarks and updates the Lightweight Commands section. `/bench full` always re-measures the
 * Integration Heavy Commands section by dispatching the full benchmark workflow on the pull
 * request's branch, and re-runs the lightweight part only when that section is behind the head
 * commit; the pull request gets a reply when nothing can run.
 * Run in CI as: `bun .github/scripts/cli-bench/rerun.ts`.
 */
import { appendFileSync } from "node:fs";

import { fetchAuthorPermission, WRITE_PERMISSIONS } from "../contribution-gate.ts";
import { githubFetch, GithubRequestError, listIssueComments, requireEnv } from "./github.ts";
import { findBenchComment, parseSections, sectionFailed } from "./post-comment.ts";

export const BENCH_COMMAND = "/bench";
export const BENCH_FULL_COMMAND = "/bench full";
/** Base branches the benchmark runs for; keep in sync with the workflow's `branches:` filter. */
export const BENCH_BASE_BRANCHES: ReadonlyArray<string> = ["develop"];
/** The workflow file whose runs `/bench` re-runs. */
export const WORKFLOW_FILE = "cli-bench.yml";
/** The workflow `/bench full` dispatches. */
export const FULL_WORKFLOW_FILE = "cli-bench-full.yml";
/** GitHub refuses to re-run a workflow run older than this. */
export const RERUN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface BenchPr {
  state: "open" | "closed";
  draft: boolean;
  headSha: string;
  /** Name of the head branch. */
  headRef: string;
  /** `owner/name` of the head repository, empty when it was deleted. */
  headRepoFullName: string;
  baseRepoFullName: string;
  baseRef: string;
}

export interface WorkflowRun {
  id: number;
  status: string;
  createdAt: string;
}

export interface FullRun {
  id: number;
  status: string;
  /** The run name, which carries the `workloads` input. */
  displayTitle: string;
  url: string;
}

/** What a dispatched full run measures. */
export type FullWorkloads = "integration-heavy" | "all";

export interface CommandInput {
  prNumber: number;
  comment: { id: number; authorLogin: string; authorAssociation: string; body: string };
  now: Date;
}

export interface CommandIo {
  fetchPr: (prNumber: number) => Promise<BenchPr>;
  fetchPermission: (login: string) => Promise<string | undefined>;
  /** Runs of the benchmark workflow triggered by `pull_request` for this commit, any order. */
  listRuns: (headSha: string) => Promise<ReadonlyArray<WorkflowRun>>;
  rerun: (runId: number) => Promise<void>;
  /** Dispatched runs of the full workflow on a branch, any order. */
  listFullRuns: (headRef: string) => Promise<ReadonlyArray<FullRun>>;
  dispatchFull: (headRef: string, workloads: FullWorkloads) => Promise<void>;
  /** Short SHA of the commit the comment's Lightweight Commands section measured, if it has one. */
  lightweightSha: (prNumber: number) => Promise<string | undefined>;
  reactToComment: (commentId: number) => Promise<void>;
  replyToPr: (prNumber: number, body: string) => Promise<void>;
}

export type CommandOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "replied"; reason: string }
  | { kind: "rerun"; runId: number }
  | { kind: "dispatched"; workloads: FullWorkloads; rerunId: number | undefined };

const short = (sha: string) => sha.slice(0, 7);

/** A GitHub error message as inline code: one short line with no backticks. */
const quoted = (detail: string) =>
  `\`${detail.replaceAll("`", "'").replaceAll(/\s+/gu, " ").trim().slice(0, 200)}\``;

export const replies = {
  noRun: (sha: string) =>
    `There is no benchmark run for commit \`${short(sha)}\`. Runs start on a push that changes the ` +
    "CLI, its packages, or the benchmark workflow, and GitHub's path filter looks at only the " +
    "first 300 changed files, so this pull request may not have one.",
  running: (sha: string) =>
    `A benchmark is already running for commit \`${short(sha)}\`. The comment updates when it finishes.`,
  draft: () => `This pull request is a draft. The benchmark runs once it is ready for review.`,
  expired: (sha: string) =>
    `The benchmark could not be re-run for commit \`${short(sha)}\`: its run is older than 30 days. ` +
    "Push a new commit to benchmark again.",
  refused: (sha: string, status: number, detail: string) =>
    `The benchmark could not be re-run for commit \`${short(sha)}\`: GitHub refused the request ` +
    `(${status} ${quoted(detail)}).`,
  notEligible: () =>
    `\`${BENCH_FULL_COMMAND}\` runs only on pull requests from this repository into ` +
    `${BENCH_BASE_BRANCHES.join(" or ")}.`,
  fullRunning: (url: string) =>
    `An integration-heavy benchmark is already queued or running for this pull request: ${url}. ` +
    "The comment updates when it finishes.",
  noFullWorkflow: () =>
    "This branch does not have the full benchmark workflow yet. Merge `develop` into the branch " +
    `and comment \`${BENCH_FULL_COMMAND}\` again.`,
  fullRefused: (status: number, detail: string) =>
    `The integration-heavy benchmark could not be started: GitHub refused the request ` +
    `(${status} ${quoted(detail)}).`,
};

/** The commit of a comment's lightweight section, unless that section reports a failed run. */
export function reportedLightweightSha(body: string): string | undefined {
  const section = parseSections(body).lightweight;
  return section === undefined || sectionFailed(section.content) ? undefined : section.sha;
}

const FULL_RUN_WORKLOADS = /\((lightweight|integration-heavy|all)\)/u;

/** Whether a full run's name says it measures the integration-heavy workloads. */
export function coversIntegrationHeavy(displayTitle: string): boolean {
  const workloads = FULL_RUN_WORKLOADS.exec(displayTitle)?.[1];
  return workloads === "integration-heavy" || workloads === "all";
}

const isCommand = (body: string) => body.trim() === BENCH_COMMAND;
const isFullCommand = (body: string) => body.trim() === BENCH_FULL_COMMAND;

/** Handles one `/bench` or `/bench full` comment; a rejected command is ignored without a reply. */
export async function handleBenchCommand(
  input: CommandInput,
  io: CommandIo,
): Promise<CommandOutcome> {
  const { comment, prNumber } = input;
  const full = isFullCommand(comment.body);
  // The workflow's `if:` only pre-filters on `startsWith`, so any other text must be rejected here.
  if (!full && !isCommand(comment.body)) {
    return {
      kind: "ignored",
      reason: `Comment is not exactly ${BENCH_COMMAND} or ${BENCH_FULL_COMMAND}.`,
    };
  }
  const command = full ? BENCH_FULL_COMMAND : BENCH_COMMAND;
  // Only the repository OWNER skips the lookup: MEMBER and COLLABORATOR do not imply push access.
  const permission = await io.fetchPermission(comment.authorLogin);
  const authorized =
    comment.authorAssociation === "OWNER" ||
    (permission !== undefined && WRITE_PERMISSIONS.has(permission));
  if (!authorized) {
    return {
      kind: "ignored",
      reason:
        `Commenter @${comment.authorLogin} is not authorized to run ${command} ` +
        `(author_association=${comment.authorAssociation}, permission=${permission ?? "n/a"}).`,
    };
  }
  const pr = await io.fetchPr(prNumber);
  if (pr.state === "closed") return { kind: "ignored", reason: `PR #${prNumber} is closed.` };

  const reply = async (text: string): Promise<CommandOutcome> => {
    await io.replyToPr(prNumber, text);
    return { kind: "replied", reason: text };
  };
  const eligible =
    pr.headRepoFullName === pr.baseRepoFullName && BENCH_BASE_BRANCHES.includes(pr.baseRef);
  if (!eligible) {
    return full
      ? reply(replies.notEligible())
      : {
          kind: "ignored",
          reason:
            pr.headRepoFullName !== pr.baseRepoFullName
              ? `${BENCH_COMMAND} runs only on pull requests from this repository.`
              : `${BENCH_COMMAND} runs only on pull requests into ${BENCH_BASE_BRANCHES.join(" or ")}.`,
        };
  }
  if (pr.draft) return reply(replies.draft());

  const latest = [...(await io.listRuns(pr.headSha))].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0];
  const expired =
    latest !== undefined && input.now.getTime() - Date.parse(latest.createdAt) > RERUN_WINDOW_MS;

  if (!full) {
    if (latest === undefined) return reply(replies.noRun(pr.headSha));
    if (latest.status !== "completed") return reply(replies.running(pr.headSha));
    if (expired) return reply(replies.expired(pr.headSha));
    try {
      await io.rerun(latest.id);
    } catch (error) {
      if (error instanceof GithubRequestError) {
        return reply(replies.refused(pr.headSha, error.status, error.detail));
      }
      throw error;
    }
    await react(io, comment.id);
    return { kind: "rerun", runId: latest.id };
  }

  const active = (await io.listFullRuns(pr.headRef)).find(
    (stackRun) => stackRun.status !== "completed" && coversIntegrationHeavy(stackRun.displayTitle),
  );
  if (active !== undefined) return reply(replies.fullRunning(active.url));

  // The lightweight part refreshes only when its section is behind the head commit and no
  // lightweight run is already in flight; with no run to re-run, the full run measures it too.
  const sectionSha = await io.lightweightSha(prNumber);
  const lightweightCurrent = sectionSha !== undefined && pr.headSha.startsWith(sectionSha);
  const lightweightInFlight = latest !== undefined && latest.status !== "completed";
  const needsLightweight = !lightweightCurrent && !lightweightInFlight;
  const rerunnable = latest !== undefined && !expired ? latest : undefined;
  const workloads: FullWorkloads =
    needsLightweight && rerunnable === undefined ? "all" : "integration-heavy";

  try {
    await io.dispatchFull(pr.headRef, workloads);
  } catch (error) {
    if (!(error instanceof GithubRequestError)) throw error;
    const missing =
      error.status === 404 || (error.status === 422 && /workflow_dispatch/u.test(error.detail));
    return reply(
      missing ? replies.noFullWorkflow() : replies.fullRefused(error.status, error.detail),
    );
  }

  let rerunId: number | undefined;
  if (needsLightweight && rerunnable !== undefined) {
    try {
      await io.rerun(rerunnable.id);
      rerunId = rerunnable.id;
    } catch (error) {
      // The full run is already under way; a refused lightweight re-run must not hide it.
      console.warn(
        `Could not re-run the lightweight benchmark run ${rerunnable.id}: ${String(error)}`,
      );
    }
  }
  await react(io, comment.id);
  return { kind: "dispatched", workloads, rerunId };
}

/** Cosmetic: a failed reaction must never hide an accepted command. */
async function react(io: CommandIo, commentId: number): Promise<void> {
  try {
    await io.reactToComment(commentId);
  } catch (error) {
    console.warn(`Could not react to comment ${commentId}: ${String(error)}`);
  }
}

async function main(): Promise<void> {
  const token = requireEnv("GITHUB_TOKEN");
  const [owner = "", repo = ""] = requireEnv("GITHUB_REPOSITORY").split("/");
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const prNumber = Number(requireEnv("PR_NUMBER"));

  const io: CommandIo = {
    fetchPr: async (n) => {
      const value = (await (await githubFetch(`${base}/pulls/${n}`, token)).json()) as {
        state: "open" | "closed";
        draft: boolean;
        head: { sha: string; ref: string; repo: { full_name: string } | null };
        base: { ref: string; repo: { full_name: string } };
      };
      return {
        state: value.state,
        draft: value.draft,
        headSha: value.head.sha,
        headRef: value.head.ref,
        headRepoFullName: value.head.repo?.full_name ?? "",
        baseRepoFullName: value.base.repo.full_name,
        baseRef: value.base.ref,
      };
    },
    fetchPermission: (login) => fetchAuthorPermission(token, owner, repo, login),
    listRuns: async (headSha) => {
      const url =
        `${base}/actions/workflows/${WORKFLOW_FILE}/runs` +
        `?event=pull_request&head_sha=${headSha}&per_page=100`;
      const payload = (await (await githubFetch(url, token)).json()) as {
        workflow_runs: Array<{ id: number; status: string; created_at: string; head_sha: string }>;
      };
      return payload.workflow_runs
        .filter((run) => run.head_sha === headSha)
        .map((run) => ({ id: run.id, status: run.status, createdAt: run.created_at }));
    },
    rerun: async (runId) => {
      await githubFetch(`${base}/actions/runs/${runId}/rerun`, token, { method: "POST" });
    },
    listFullRuns: async (headRef) => {
      const url =
        `${base}/actions/workflows/${FULL_WORKFLOW_FILE}/runs` +
        `?event=workflow_dispatch&branch=${encodeURIComponent(headRef)}&per_page=50`;
      const payload = await githubFetch(url, token).then(
        (response) =>
          response.json() as Promise<{
            workflow_runs: Array<{
              id: number;
              status: string;
              display_title: string;
              html_url: string;
            }>;
          }>,
        (error: unknown) => {
          // A branch without the workflow file has no runs of it.
          if (error instanceof GithubRequestError && error.status === 404) {
            return { workflow_runs: [] };
          }
          throw error;
        },
      );
      return payload.workflow_runs.map((run) => ({
        id: run.id,
        status: run.status,
        displayTitle: run.display_title,
        url: run.html_url,
      }));
    },
    dispatchFull: async (headRef, workloads) => {
      await githubFetch(`${base}/actions/workflows/${FULL_WORKFLOW_FILE}/dispatches`, token, {
        method: "POST",
        body: JSON.stringify({
          ref: `refs/heads/${headRef}`,
          inputs: { workloads, runtime: "both", base: "merge-base" },
        }),
      });
    },
    lightweightSha: async (n) => {
      const existing = findBenchComment(await listIssueComments(token, base, n));
      return existing === undefined ? undefined : reportedLightweightSha(existing.body);
    },
    reactToComment: async (commentId) => {
      await githubFetch(`${base}/issues/comments/${commentId}/reactions`, token, {
        method: "POST",
        body: JSON.stringify({ content: "eyes" }),
      });
    },
    replyToPr: async (n, body) => {
      await githubFetch(`${base}/issues/${n}/comments`, token, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },
  };

  const outcome = await handleBenchCommand(
    {
      prNumber,
      comment: {
        id: Number(requireEnv("COMMENT_ID")),
        authorLogin: requireEnv("COMMENT_AUTHOR_LOGIN"),
        authorAssociation: requireEnv("COMMENT_AUTHOR_ASSOCIATION"),
        body: requireEnv("COMMENT_BODY"),
      },
      now: new Date(),
    },
    io,
  );
  const message =
    outcome.kind === "rerun"
      ? `Re-running benchmark run ${outcome.runId} for PR #${prNumber}.`
      : outcome.kind === "dispatched"
        ? `Dispatched the full benchmark (${outcome.workloads}) for PR #${prNumber}${
            outcome.rerunId === undefined ? "" : ` and re-running benchmark run ${outcome.rerunId}`
          }.`
        : `${outcome.kind === "replied" ? "Replied on" : "Ignored command on"} PR #${prNumber}: ${outcome.reason}`;
  console.log(message);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, `${message}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
