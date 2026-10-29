/**
 * `/bench` handler: re-runs the benchmark workflow run of a pull request's current head commit.
 *
 * Runs default branch code and never checks out or runs pull request code. The commenter must be
 * the repository owner or hold write access, and the pull request must be an open, ready one from
 * this repository into `develop`. The command re-runs the existing `pull_request` run, which
 * benchmarks and updates the comment; the pull request gets a reply when no run can be re-run.
 * Run in CI as: `bun .github/scripts/cli-bench/rerun.ts`.
 */
import { appendFileSync } from "node:fs";

import { fetchAuthorPermission, WRITE_PERMISSIONS } from "../contribution-gate.ts";
import { githubFetch, GithubRequestError, requireEnv } from "./github.ts";

export const BENCH_COMMAND = "/bench";
/** Base branches the benchmark runs for; keep in sync with the workflow's `branches:` filter. */
export const BENCH_BASE_BRANCHES: ReadonlyArray<string> = ["develop"];
/** The workflow file whose runs `/bench` re-runs. */
export const WORKFLOW_FILE = "cli-bench.yml";
/** GitHub refuses to re-run a workflow run older than this. */
export const RERUN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface BenchPr {
  state: "open" | "closed";
  draft: boolean;
  headSha: string;
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
  reactToComment: (commentId: number) => Promise<void>;
  replyToPr: (prNumber: number, body: string) => Promise<void>;
}

export type CommandOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "replied"; reason: string }
  | { kind: "rerun"; runId: number };

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
};

/** Handles one `/bench` comment; a rejected command is ignored without a reply. */
export async function handleBenchCommand(
  input: CommandInput,
  io: CommandIo,
): Promise<CommandOutcome> {
  const { comment, prNumber } = input;
  // The workflow's `if:` only pre-filters on `startsWith`, so `/bench full` must be rejected here.
  if (comment.body.trim() !== BENCH_COMMAND) {
    return { kind: "ignored", reason: `Comment is not exactly ${BENCH_COMMAND}.` };
  }
  // Only the repository OWNER skips the lookup: MEMBER and COLLABORATOR do not imply push access.
  const permission = await io.fetchPermission(comment.authorLogin);
  const authorized =
    comment.authorAssociation === "OWNER" ||
    (permission !== undefined && WRITE_PERMISSIONS.has(permission));
  if (!authorized) {
    return {
      kind: "ignored",
      reason:
        `Commenter @${comment.authorLogin} is not authorized to run ${BENCH_COMMAND} ` +
        `(author_association=${comment.authorAssociation}, permission=${permission ?? "n/a"}).`,
    };
  }
  const pr = await io.fetchPr(prNumber);
  if (pr.state === "closed") return { kind: "ignored", reason: `PR #${prNumber} is closed.` };
  if (pr.headRepoFullName !== pr.baseRepoFullName) {
    return {
      kind: "ignored",
      reason: `${BENCH_COMMAND} runs only on pull requests from this repository.`,
    };
  }
  if (!BENCH_BASE_BRANCHES.includes(pr.baseRef)) {
    return {
      kind: "ignored",
      reason: `${BENCH_COMMAND} runs only on pull requests into ${BENCH_BASE_BRANCHES.join(" or ")}.`,
    };
  }

  const reply = async (text: string): Promise<CommandOutcome> => {
    await io.replyToPr(prNumber, text);
    return { kind: "replied", reason: text };
  };
  if (pr.draft) return reply(replies.draft());

  const latest = [...(await io.listRuns(pr.headSha))].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0];
  if (latest === undefined) return reply(replies.noRun(pr.headSha));
  if (latest.status !== "completed") return reply(replies.running(pr.headSha));
  if (input.now.getTime() - Date.parse(latest.createdAt) > RERUN_WINDOW_MS) {
    return reply(replies.expired(pr.headSha));
  }

  try {
    await io.rerun(latest.id);
  } catch (error) {
    if (error instanceof GithubRequestError) {
      return reply(replies.refused(pr.headSha, error.status, error.detail));
    }
    throw error;
  }
  // Cosmetic: a failed reaction must never hide an accepted re-run.
  try {
    await io.reactToComment(comment.id);
  } catch (error) {
    console.warn(`Could not react to comment ${comment.id}: ${String(error)}`);
  }
  return { kind: "rerun", runId: latest.id };
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
        head: { sha: string; repo: { full_name: string } | null };
        base: { ref: string; repo: { full_name: string } };
      };
      return {
        state: value.state,
        draft: value.draft,
        headSha: value.head.sha,
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
