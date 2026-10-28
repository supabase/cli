/**
 * CLI benchmark resolver: decides whether the benchmark runs and for which commit.
 *
 * Two triggers:
 *   - `pull_request`: runs for the event's head commit; the event payload is the only input.
 *   - a maintainer's `/bench` comment on a pull request from this repository: runs for the pull request's head commit
 *     when this workflow accepts the command. The comment must be exactly `/bench`, and the
 *     commenter must be the repository owner or hold write access.
 *
 * `resolveBench` is pure orchestration with injected I/O; `main()` wires the real GitHub calls and
 * writes the outputs the workflow reads. Run in CI as: `bun .github/scripts/cli-bench/resolve.ts`.
 */
import { appendFileSync } from "node:fs";

import { fetchAuthorPermission, WRITE_PERMISSIONS } from "../contribution-gate.ts";
import { githubFetch, requireEnv } from "./github.ts";

export const BENCH_COMMAND = "/bench";

export type Trigger = "auto" | "command";

export interface BenchPr {
  state: "open" | "closed";
  headSha: string;
  /** `owner/name` of the head repository, empty when it was deleted. */
  headRepoFullName: string;
  baseRepoFullName: string;
  baseRef: string;
}

export type ResolveInput =
  | { eventName: "pull_request"; prNumber: number; pr: BenchPr }
  | {
      eventName: "issue_comment";
      prNumber: number;
      comment: { id: number; authorLogin: string; authorAssociation: string; body: string };
    };

export interface ResolveIo {
  fetchPr: (prNumber: number) => Promise<BenchPr>;
  fetchPermission: (login: string) => Promise<string | undefined>;
  reactToComment: (commentId: number) => Promise<void>;
}

export interface ResolveResult {
  shouldRun: boolean;
  skipReason?: string;
  trigger: Trigger;
  headSha: string;
  baseRef: string;
  /** Whether the head commit lives in a repository other than the base repository. */
  isFork: boolean;
}

const skipped = (trigger: Trigger, skipReason: string): ResolveResult => ({
  shouldRun: false,
  skipReason,
  trigger,
  headSha: "",
  baseRef: "",
  isFork: false,
});

const accepted = (trigger: Trigger, pr: BenchPr): ResolveResult => ({
  shouldRun: true,
  trigger,
  headSha: pr.headSha,
  baseRef: pr.baseRef,
  isFork: pr.headRepoFullName !== pr.baseRepoFullName,
});

/** Decides whether the benchmark runs; never throws for an unauthorized or malformed command. */
export async function resolveBench(input: ResolveInput, io: ResolveIo): Promise<ResolveResult> {
  if (input.eventName === "pull_request") return accepted("auto", input.pr);

  const { comment } = input;
  // The workflow's `if:` only pre-filters on `startsWith`, so `/bench full` must be rejected here.
  if (comment.body.trim() !== BENCH_COMMAND) {
    return skipped("command", `Comment is not exactly ${BENCH_COMMAND}.`);
  }
  // Only the repository OWNER skips the lookup: MEMBER and COLLABORATOR do not imply push access.
  const permission = await io.fetchPermission(comment.authorLogin);
  const authorized =
    comment.authorAssociation === "OWNER" ||
    (permission !== undefined && WRITE_PERMISSIONS.has(permission));
  if (!authorized) {
    return skipped(
      "command",
      `Commenter @${comment.authorLogin} is not authorized to run ${BENCH_COMMAND} ` +
        `(author_association=${comment.authorAssociation}, permission=${permission ?? "n/a"}).`,
    );
  }
  const pr = await io.fetchPr(input.prNumber);
  if (pr.state === "closed") return skipped("command", `PR #${input.prNumber} is closed.`);
  // Only same-repository branches run: their authors already get repository secrets on a pull request.
  if (pr.headRepoFullName !== pr.baseRepoFullName) {
    return skipped("command", `${BENCH_COMMAND} runs only on pull requests from this repository.`);
  }

  // Cosmetic: a failed reaction must never fail an authorized run.
  try {
    await io.reactToComment(comment.id);
  } catch (error) {
    console.warn(`Could not react to comment ${comment.id}: ${String(error)}`);
  }
  return accepted("command", pr);
}

async function fetchPr(token: string, base: string, prNumber: number): Promise<BenchPr> {
  const value = (await (await githubFetch(`${base}/pulls/${prNumber}`, token)).json()) as {
    state: "open" | "closed";
    head: { sha: string; repo: { full_name: string } | null };
    base: { ref: string; repo: { full_name: string } };
  };
  return {
    state: value.state,
    headSha: value.head.sha,
    headRepoFullName: value.head.repo?.full_name ?? "",
    baseRepoFullName: value.base.repo.full_name,
    baseRef: value.base.ref,
  };
}

/** Writes each output with a random delimiter so a value can never inject extra output lines. */
function writeOutputs(result: ResolveResult, prNumber: number): void {
  const entries: Record<string, string> = {
    should_run: String(result.shouldRun),
    pr_number: String(prNumber),
    head_sha: result.headSha,
    base_ref: result.baseRef,
    is_fork: String(result.isFork),
    trigger: result.trigger,
  };
  const lines = Object.entries(entries).map(([name, value]) => {
    const delimiter = `ghadelim_${crypto.randomUUID()}`;
    return `${name}<<${delimiter}\n${value}\n${delimiter}`;
  });
  appendFileSync(requireEnv("GITHUB_OUTPUT"), `${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const token = requireEnv("GITHUB_TOKEN");
  const [owner, repo] = requireEnv("GITHUB_REPOSITORY").split("/");
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const prNumber = Number(requireEnv("PR_NUMBER"));
  const eventName = requireEnv("EVENT_NAME");

  const io: ResolveIo = {
    fetchPr: (n) => fetchPr(token, base, n),
    fetchPermission: (login) => fetchAuthorPermission(token, owner!, repo!, login),
    reactToComment: async (commentId) => {
      await githubFetch(`${base}/issues/comments/${commentId}/reactions`, token, {
        method: "POST",
        body: JSON.stringify({ content: "eyes" }),
      });
    },
  };

  let input: ResolveInput;
  if (eventName === "pull_request") {
    input = {
      eventName,
      prNumber,
      pr: {
        state: "open",
        headSha: requireEnv("HEAD_SHA"),
        headRepoFullName: process.env.HEAD_REPO ?? "",
        baseRepoFullName: requireEnv("GITHUB_REPOSITORY"),
        baseRef: requireEnv("BASE_REF"),
      },
    };
  } else if (eventName === "issue_comment") {
    input = {
      eventName,
      prNumber,
      comment: {
        id: Number(requireEnv("COMMENT_ID")),
        authorLogin: requireEnv("COMMENT_AUTHOR_LOGIN"),
        authorAssociation: requireEnv("COMMENT_AUTHOR_ASSOCIATION"),
        body: requireEnv("COMMENT_BODY"),
      },
    };
  } else {
    throw new Error(`Unsupported EVENT_NAME "${eventName}".`);
  }

  const result = await resolveBench(input, io);
  console.log(
    `CLI benchmark resolve for PR #${prNumber}: should_run=${result.shouldRun} ` +
      `trigger=${result.trigger}${result.skipReason ? ` (${result.skipReason})` : ""}`,
  );
  writeOutputs(result, prNumber);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (result.skipReason && summaryFile) appendFileSync(summaryFile, `${result.skipReason}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
