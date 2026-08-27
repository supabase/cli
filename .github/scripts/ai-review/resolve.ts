/**
 * AI review resolver: decides whether the one-shot AI review pipeline should
 * run for a PR, and in which mode.
 *
 * The pipeline runs EXACTLY ONCE per PR, so this is the only gate standing
 * between "new commit lands" and "Claude + Codex burn API budget again". Two
 * triggers feed it:
 *   - manual (`workflow_dispatch` or an internal maintainer's `/ai-review`
 *     issue comment): a human explicitly asked for a review, so the
 *     marker/dedup guard and the draft/fork/bot skips are bypassed. The size
 *     guard still applies — nobody can force a review of an 8000-line diff.
 *   - auto (`pull_request` `opened`/`ready_for_review`, currently commented
 *     out in the workflow while prompts are tuned): skips drafts, bots, fork
 *     PRs (v1 is internal-PRs-only; forks go through the manual maintainer
 *     path), and PRs that already carry a marker comment/review from a prior
 *     run.
 *
 * `resolveDecision` is the pure orchestration function (I/O injected, like
 * `evaluateAllOpenPrs` in `contribution-gate.ts`) that a test can drive
 * without the network; `main()` wires up the real GitHub I/O and writes the
 * step outputs `should_run`, `skip_reason`, `pr_number`, `head_ref`, `mode`,
 * and `trigger` to `$GITHUB_OUTPUT`.
 *
 * Run in CI as: `bun .github/scripts/ai-review/resolve.ts`.
 */

import { appendFileSync } from "node:fs";

import { fetchAuthorPermission, isInternalAuthor } from "../contribution-gate.ts";

/** Hidden marker every posted AI review carries. Duplicated (not imported)
 * in `post-review.ts`, which owns posting; keep the two literals in sync. */
export const AI_REVIEW_MARKER = "<!-- supabase-ai-review -->";

/** Diff size above which a review is deferred to a "too large" notice instead
 * of burning a Claude + Codex pass on a diff nobody will read end to end. */
const MAX_CHANGED_LINES = 8000;
const MAX_CHANGED_FILES = 120;

export type EventName = "workflow_dispatch" | "issue_comment" | "pull_request";
export type Mode = "review" | "too-large";
export type Trigger = "auto" | "manual";

export interface TriggeringComment {
  id: number;
  authorLogin: string;
  authorAssociation: string;
}

export interface ResolveInput {
  eventName: EventName;
  prNumber: number;
  /** Present only for `issue_comment` events. */
  comment?: TriggeringComment;
}

/** Minimal PR shape the resolver needs to decide. */
export interface PrDetails {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  authorIsBot: boolean;
  /** `owner/name` of the fork/branch the PR is from, empty when the head repo was deleted. */
  headRepoFullName: string;
  /** `owner/name` of the repository the PR targets. */
  baseRepoFullName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** A prior review or issue comment, checked for the dedup marker. */
export interface MarkedBody {
  body: string;
}

/** Injected GitHub I/O so `resolveDecision` can be unit-tested without the network. */
export interface ResolveIo {
  fetchPr: (prNumber: number) => Promise<PrDetails>;
  listReviews: (prNumber: number) => Promise<MarkedBody[]>;
  listIssueComments: (prNumber: number) => Promise<MarkedBody[]>;
  /** Resolve a commenter's effective repository permission; see `fetchAuthorPermission`. */
  fetchPermission: (login: string) => Promise<string | undefined>;
  /** React 👀 to the triggering comment, for UX feedback that the request was picked up. */
  reactToComment: (commentId: number) => Promise<void>;
}

export interface ResolveResult {
  shouldRun: boolean;
  /** Human-readable explanation, present whenever `shouldRun` is false or `mode` is `too-large`. */
  skipReason?: string;
  mode: Mode;
  trigger: Trigger;
}

function sizeGuardMode(pr: PrDetails): Mode {
  return pr.additions + pr.deletions > MAX_CHANGED_LINES || pr.changedFiles > MAX_CHANGED_FILES
    ? "too-large"
    : "review";
}

function tooLargeResult(pr: PrDetails, trigger: Trigger): ResolveResult {
  return {
    shouldRun: true,
    skipReason:
      `PR is too large for a full AI review ` +
      `(+${pr.additions}/-${pr.deletions} lines across ${pr.changedFiles} files).`,
    mode: "too-large",
    trigger,
  };
}

function decideForPr(pr: PrDetails, trigger: Trigger): ResolveResult {
  const mode = sizeGuardMode(pr);
  return mode === "too-large" ? tooLargeResult(pr, trigger) : { shouldRun: true, mode, trigger };
}

/**
 * Pure decision orchestration for the AI review pipeline. Given the event
 * context and injected GitHub I/O, decides whether the pipeline should run
 * and in which mode.
 */
export async function resolveDecision(input: ResolveInput, io: ResolveIo): Promise<ResolveResult> {
  const trigger: Trigger = input.eventName === "pull_request" ? "auto" : "manual";
  const pr = await io.fetchPr(input.prNumber);

  if (pr.state === "closed") {
    return {
      shouldRun: false,
      skipReason: `PR #${pr.number} is closed.`,
      mode: "review",
      trigger,
    };
  }

  if (trigger === "manual") {
    if (input.eventName === "issue_comment") {
      const comment = input.comment;
      if (!comment) {
        throw new Error("issue_comment trigger requires comment details");
      }
      let permission: string | undefined;
      let isInternal = isInternalAuthor(comment.authorAssociation, undefined);
      if (!isInternal) {
        permission = await io.fetchPermission(comment.authorLogin);
        isInternal = isInternalAuthor(comment.authorAssociation, permission);
      }
      if (!isInternal) {
        return {
          shouldRun: false,
          skipReason:
            `Commenter @${comment.authorLogin} is not an internal maintainer ` +
            `(author_association=${comment.authorAssociation}, permission=${permission ?? "n/a"}); ` +
            `only maintainers can trigger /ai-review.`,
          mode: "review",
          trigger,
        };
      }
      await io.reactToComment(comment.id);
    }
    // A maintainer explicitly asked, so the marker/dedup guard and the
    // draft/fork/bot skips below don't apply — only the size guard does.
    return decideForPr(pr, trigger);
  }

  // Auto trigger (future `pull_request` events): v1 is internal-PRs-only and
  // fires at most once per PR.
  if (pr.draft) {
    return { shouldRun: false, skipReason: "PR is a draft.", mode: "review", trigger };
  }
  if (pr.authorIsBot) {
    return { shouldRun: false, skipReason: "PR author is a bot.", mode: "review", trigger };
  }
  if (pr.headRepoFullName !== pr.baseRepoFullName) {
    return {
      shouldRun: false,
      skipReason: "PR is from a fork; ask a maintainer to comment /ai-review instead.",
      mode: "review",
      trigger,
    };
  }

  const [reviews, comments] = await Promise.all([
    io.listReviews(pr.number),
    io.listIssueComments(pr.number),
  ]);
  const alreadyReviewed = [...reviews, ...comments].some((entry) =>
    entry.body.includes(AI_REVIEW_MARKER),
  );
  if (alreadyReviewed) {
    return {
      shouldRun: false,
      skipReason: "PR already received an AI review; comment /ai-review to request another.",
      mode: "review",
      trigger,
    };
  }

  return decideForPr(pr, trigger);
}

// --- GitHub I/O (only runs when executed directly) ---

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function githubFetch(
  url: string,
  token: string,
  init: Omit<RequestInit, "headers"> = {},
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}) for ${url}: ${body}`);
  }
  return response;
}

interface RestPullRequest {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  user: { type: string } | null;
  head: { repo: { full_name: string } | null };
  base: { repo: { full_name: string } };
  additions: number;
  deletions: number;
  changed_files: number;
}

async function fetchPullRequest(token: string, base: string, prNumber: number): Promise<PrDetails> {
  const response = await githubFetch(`${base}/pulls/${prNumber}`, token);
  const pr: RestPullRequest = await response.json();
  return {
    number: pr.number,
    state: pr.state,
    draft: pr.draft,
    authorIsBot: pr.user?.type === "Bot",
    headRepoFullName: pr.head.repo?.full_name ?? "",
    baseRepoFullName: pr.base.repo.full_name,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
  };
}

async function listAllPages(token: string, url: string): Promise<Array<{ body: string | null }>> {
  const entries: Array<{ body: string | null }> = [];
  for (let page = 1; ; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const response = await githubFetch(`${url}${separator}per_page=100&page=${page}`, token);
    const batch: Array<{ body: string | null }> = await response.json();
    entries.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return entries;
}

async function listReviews(token: string, base: string, prNumber: number): Promise<MarkedBody[]> {
  const entries = await listAllPages(token, `${base}/pulls/${prNumber}/reviews`);
  return entries.map((entry) => ({ body: entry.body ?? "" }));
}

async function listIssueComments(
  token: string,
  base: string,
  prNumber: number,
): Promise<MarkedBody[]> {
  const entries = await listAllPages(token, `${base}/issues/${prNumber}/comments`);
  return entries.map((entry) => ({ body: entry.body ?? "" }));
}

async function reactToComment(token: string, base: string, commentId: number): Promise<void> {
  await githubFetch(`${base}/issues/comments/${commentId}/reactions`, token, {
    method: "POST",
    body: JSON.stringify({ content: "eyes" }),
  });
}

function writeOutputs(result: ResolveResult, prNumber: number): void {
  const outputFile = requireEnv("GITHUB_OUTPUT");
  const lines = [
    `should_run=${result.shouldRun}`,
    `skip_reason=${result.skipReason ?? ""}`,
    `pr_number=${prNumber}`,
    `head_ref=refs/pull/${prNumber}/head`,
    `mode=${result.mode}`,
    `trigger=${result.trigger}`,
  ];
  // Append rather than overwrite: $GITHUB_OUTPUT may already carry lines from
  // earlier steps in the same job.
  appendFileSync(outputFile, `${lines.join("\n")}\n`);
}

function parseEventName(value: string): EventName {
  if (value !== "workflow_dispatch" && value !== "issue_comment" && value !== "pull_request") {
    throw new Error(
      `Invalid EVENT_NAME "${value}"; expected one of workflow_dispatch, issue_comment, pull_request.`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  const token = requireEnv("GITHUB_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const [owner, repo] = repository.split("/");
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const eventName = parseEventName(requireEnv("EVENT_NAME"));
  const prNumber = Number(requireEnv("PR_NUMBER"));

  let comment: TriggeringComment | undefined;
  if (eventName === "issue_comment") {
    comment = {
      id: Number(requireEnv("COMMENT_ID")),
      authorLogin: requireEnv("COMMENT_AUTHOR_LOGIN"),
      authorAssociation: requireEnv("COMMENT_AUTHOR_ASSOCIATION"),
    };
  }

  const io: ResolveIo = {
    fetchPr: (n) => fetchPullRequest(token, base, n),
    listReviews: (n) => listReviews(token, base, n),
    listIssueComments: (n) => listIssueComments(token, base, n),
    fetchPermission: (login) => fetchAuthorPermission(token, owner!, repo!, login),
    reactToComment: (commentId) => reactToComment(token, base, commentId),
  };

  const result = await resolveDecision({ eventName, prNumber, comment }, io);

  console.log(
    `AI review resolve for PR #${prNumber}: should_run=${result.shouldRun} mode=${result.mode} ` +
      `trigger=${result.trigger}${result.skipReason ? ` (${result.skipReason})` : ""}`,
  );

  writeOutputs(result, prNumber);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
