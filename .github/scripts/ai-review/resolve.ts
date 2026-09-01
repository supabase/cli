/**
 * AI review resolver: decides whether the one-shot AI review pipeline should
 * run for a PR.
 *
 * The pipeline runs EXACTLY ONCE per PR, so this is the only gate standing
 * between "new commit lands" and "Claude + Codex burn API budget again". Two
 * triggers feed it:
 *   - manual (`workflow_dispatch` or an internal maintainer's `/ai-review`
 *     issue comment): a human explicitly asked for a review, so the
 *     marker/dedup guard and the draft/fork/bot skips are bypassed.
 *   - auto (`pull_request` `opened`/`ready_for_review`): only PRs whose
 *     author has repository write access get the automatic review. Skips
 *     drafts, bots, fork PRs, authors without write access (external
 *     contributors go through the manual maintainer path), and PRs that
 *     already carry a marker comment/review from a prior run.
 *
 * `resolveDecision` is the pure orchestration function (I/O injected, like
 * `evaluateAllOpenPrs` in `contribution-gate.ts`) that a test can drive
 * without the network; `main()` wires up the real GitHub I/O, writes the
 * step outputs `should_run`, `pr_number`, `head_ref`, and `trigger` to
 * `$GITHUB_OUTPUT`, and surfaces the skip reason (if any) in
 * `$GITHUB_STEP_SUMMARY`.
 *
 * Run in CI as: `bun .github/scripts/ai-review/resolve.ts`.
 */

import { appendFileSync } from "node:fs";

import { fetchAuthorPermission, WRITE_PERMISSIONS } from "../contribution-gate.ts";
import { AI_REVIEW_MARKER } from "./post-review.ts";

// Re-export so existing consumers (tests, this file's own dedup check) can
// keep importing the marker from `resolve.ts`; `post-review.ts` — which owns
// posting — is the single source of truth for the literal.
export { AI_REVIEW_MARKER };

/** Login every review/comment posted by this workflow carries. Duplicated
 * (not imported) from `post-review.ts`'s `WORKFLOW_BOT_LOGIN`; keep the two
 * literals in sync. */
const WORKFLOW_BOT_LOGIN = "github-actions[bot]";

export type EventName = "workflow_dispatch" | "issue_comment" | "pull_request";
export type Trigger = "auto" | "manual";

export interface TriggeringComment {
  id: number;
  authorLogin: string;
  authorAssociation: string;
  /** Full comment body, needed to check the command matches `/ai-review`
   * exactly (the workflow's `if:` only pre-filters on `startsWith`). */
  body: string;
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
  /** PR author's login, empty when the author account was deleted. */
  authorLogin: string;
  /** `owner/name` of the fork/branch the PR is from, empty when the head repo was deleted. */
  headRepoFullName: string;
  /** `owner/name` of the repository the PR targets. */
  baseRepoFullName: string;
}

/** A prior review or issue comment, checked for the dedup marker. */
export interface MarkedBody {
  body: string;
  authorLogin: string;
}

/** Injected GitHub I/O so `resolveDecision` can be unit-tested without the network. */
export interface ResolveIo {
  fetchPr: (prNumber: number) => Promise<PrDetails>;
  listReviews: (prNumber: number) => Promise<MarkedBody[]>;
  listIssueComments: (prNumber: number) => Promise<MarkedBody[]>;
  /** Resolve a user's effective repository permission; see `fetchAuthorPermission`. */
  fetchPermission: (login: string) => Promise<string | undefined>;
  /** React 👀 to the triggering comment, for UX feedback that the request was picked up. */
  reactToComment: (commentId: number) => Promise<void>;
}

export interface ResolveResult {
  shouldRun: boolean;
  /** Human-readable explanation, present whenever `shouldRun` is false. */
  skipReason?: string;
  trigger: Trigger;
}

/** No size gate: Claude and Codex review agentically — reading the diff and the
 * changed files via their own tools over many turns, like the local CLI — so a
 * PR that clears the draft/bot/fork/dedup checks is reviewed regardless of its
 * size. Very large diffs are handled best-effort within the model's
 * context/turn budget. */
function decideForPr(trigger: Trigger): ResolveResult {
  return { shouldRun: true, trigger };
}

/**
 * Pure decision orchestration for the AI review pipeline. Given the event
 * context and injected GitHub I/O, decides whether the pipeline should run.
 */
export async function resolveDecision(input: ResolveInput, io: ResolveIo): Promise<ResolveResult> {
  const trigger: Trigger = input.eventName === "pull_request" ? "auto" : "manual";
  const pr = await io.fetchPr(input.prNumber);

  if (pr.state === "closed") {
    return {
      shouldRun: false,
      skipReason: `PR #${pr.number} is closed.`,
      trigger,
    };
  }

  if (trigger === "manual") {
    if (input.eventName === "issue_comment") {
      const comment = input.comment;
      if (!comment) {
        throw new Error("issue_comment trigger requires comment details");
      }

      // Authoritative command match: the workflow's job `if:` only
      // pre-filters on `startsWith('/ai-review')`, so `/ai-reviewers` or
      // `/ai-review-please` would otherwise also reach here.
      const firstLine = comment.body.split("\n")[0]?.trim() ?? "";
      if (firstLine !== "/ai-review") {
        return {
          shouldRun: false,
          skipReason: `Comment is not the exact /ai-review command (first line: ${JSON.stringify(firstLine)}).`,
          trigger,
        };
      }

      // Authoritative authorization: always resolve the commenter's
      // effective repository permission and require write/admin. Only the
      // repository OWNER may short-circuit that requirement — any other
      // association (including MEMBER/COLLABORATOR, which merely mean "in
      // the org"/"added as a collaborator", not necessarily push-capable)
      // must pass the permission check. Mirrors `contribution-gate.ts`'s
      // `WRITE_PERMISSIONS`.
      const permission = await io.fetchPermission(comment.authorLogin);
      const authorized =
        comment.authorAssociation === "OWNER" ||
        (permission !== undefined && WRITE_PERMISSIONS.has(permission));
      if (!authorized) {
        return {
          shouldRun: false,
          skipReason:
            `Commenter @${comment.authorLogin} is not authorized to run /ai-review ` +
            `(author_association=${comment.authorAssociation}, permission=${permission ?? "n/a"}); ` +
            `requires repository write access (or being the repository owner).`,
          trigger,
        };
      }

      // Cosmetic feedback only — a 403/rate-limit here must never fail an
      // otherwise-authorized run.
      try {
        await io.reactToComment(comment.id);
      } catch (error) {
        console.warn(`Could not react to comment ${comment.id}: ${String(error)}`);
      }
    }
    // A maintainer explicitly asked, so the marker/dedup guard and the
    // draft/fork/bot skips below don't apply.
    return decideForPr(trigger);
  }

  // Auto trigger (`pull_request` events): internal PRs only, fires at most
  // once per PR.
  if (pr.draft) {
    return { shouldRun: false, skipReason: "PR is a draft.", trigger };
  }
  if (pr.authorIsBot) {
    return { shouldRun: false, skipReason: "PR author is a bot.", trigger };
  }
  if (pr.headRepoFullName !== pr.baseRepoFullName) {
    return {
      shouldRun: false,
      skipReason: "PR is from a fork; ask a maintainer to comment /ai-review instead.",
      trigger,
    };
  }

  // Authoritative auto-trigger authorization: only PRs authored by someone
  // with effective repository write access are reviewed automatically. A
  // same-repo branch already implies the author could push when they opened
  // the PR, so this is defense-in-depth (it also catches access revoked
  // since); an unresolvable permission counts as unauthorized. Mirrors the
  // manual path's gate above and `contribution-gate.ts`'s `WRITE_PERMISSIONS`.
  const authorPermission = await io.fetchPermission(pr.authorLogin);
  if (authorPermission === undefined || !WRITE_PERMISSIONS.has(authorPermission)) {
    return {
      shouldRun: false,
      skipReason:
        `PR author @${pr.authorLogin} does not have repository write access ` +
        `(permission=${authorPermission ?? "n/a"}); ` +
        `a maintainer can comment /ai-review to request a review.`,
      trigger,
    };
  }

  const [reviews, comments] = await Promise.all([
    io.listReviews(pr.number),
    io.listIssueComments(pr.number),
  ]);
  // Only a marker posted BY the workflow bot counts — otherwise anyone could
  // paste the (invisible) marker into a comment to permanently suppress the
  // auto review of their own PR.
  const alreadyReviewed = [...reviews, ...comments].some(
    (entry) => entry.authorLogin === WORKFLOW_BOT_LOGIN && entry.body.includes(AI_REVIEW_MARKER),
  );
  if (alreadyReviewed) {
    return {
      shouldRun: false,
      skipReason: "PR already received an AI review; comment /ai-review to request another.",
      trigger,
    };
  }

  return decideForPr(trigger);
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
  user: { login: string; type: string } | null;
  head: { repo: { full_name: string } | null };
  base: { repo: { full_name: string } };
}

function isRecordEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The validated boundary between `Response.json()` (typed `Promise<unknown>`
 * under `@tsconfig/bun`) and this file's typed shapes: `assert` narrows the
 * parsed value to `T` before any caller reads a field off it.
 */
async function githubJson<T>(
  response: Response,
  assert: (value: unknown) => asserts value is T,
): Promise<T> {
  const value: unknown = await response.json();
  assert(value);
  return value;
}

function assertRestPullRequest(value: unknown): asserts value is RestPullRequest {
  if (
    !isRecordEntry(value) ||
    typeof value.number !== "number" ||
    (value.state !== "open" && value.state !== "closed") ||
    typeof value.draft !== "boolean" ||
    !(
      value.user === null ||
      (isRecordEntry(value.user) &&
        typeof value.user.login === "string" &&
        typeof value.user.type === "string")
    ) ||
    !isRecordEntry(value.head) ||
    !(
      value.head.repo === null ||
      (isRecordEntry(value.head.repo) && typeof value.head.repo.full_name === "string")
    ) ||
    !isRecordEntry(value.base) ||
    !isRecordEntry(value.base.repo) ||
    typeof value.base.repo.full_name !== "string"
  ) {
    throw new Error("Malformed GitHub pull request response: missing or mistyped required fields.");
  }
}

function assertMarkedEntries(
  value: unknown,
): asserts value is Array<{ body: string | null; user: { login: string } | null }> {
  const isEntry = (
    entry: unknown,
  ): entry is { body: string | null; user: { login: string } | null } =>
    isRecordEntry(entry) &&
    (entry.body === null || typeof entry.body === "string") &&
    (entry.user === null || (isRecordEntry(entry.user) && typeof entry.user.login === "string"));
  if (!Array.isArray(value) || !value.every(isEntry)) {
    throw new Error("Malformed GitHub response: expected an array of {body, user} entries.");
  }
}

async function fetchPullRequest(token: string, base: string, prNumber: number): Promise<PrDetails> {
  const response = await githubFetch(`${base}/pulls/${prNumber}`, token);
  const pr = await githubJson(response, assertRestPullRequest);
  return {
    number: pr.number,
    state: pr.state,
    draft: pr.draft,
    authorIsBot: pr.user?.type === "Bot",
    // Empty when the author account was deleted; `fetchAuthorPermission`
    // resolves an empty login to `undefined`, which the auto gate treats as
    // unauthorized.
    authorLogin: pr.user?.login ?? "",
    headRepoFullName: pr.head.repo?.full_name ?? "",
    baseRepoFullName: pr.base.repo.full_name,
  };
}

async function listAllPages(
  token: string,
  url: string,
): Promise<Array<{ body: string | null; user: { login: string } | null }>> {
  const entries: Array<{ body: string | null; user: { login: string } | null }> = [];
  for (let page = 1; ; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const response = await githubFetch(`${url}${separator}per_page=100&page=${page}`, token);
    const batch = await githubJson(response, assertMarkedEntries);
    entries.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return entries;
}

async function listReviews(token: string, base: string, prNumber: number): Promise<MarkedBody[]> {
  const entries = await listAllPages(token, `${base}/pulls/${prNumber}/reviews`);
  return entries.map((entry) => ({
    body: entry.body ?? "",
    authorLogin: entry.user?.login ?? "",
  }));
}

async function listIssueComments(
  token: string,
  base: string,
  prNumber: number,
): Promise<MarkedBody[]> {
  const entries = await listAllPages(token, `${base}/issues/${prNumber}/comments`);
  return entries.map((entry) => ({
    body: entry.body ?? "",
    authorLogin: entry.user?.login ?? "",
  }));
}

async function reactToComment(token: string, base: string, commentId: number): Promise<void> {
  await githubFetch(`${base}/issues/comments/${commentId}/reactions`, token, {
    method: "POST",
    body: JSON.stringify({ content: "eyes" }),
  });
}

/** Writes each `$GITHUB_OUTPUT` value using the heredoc/delimiter form (with
 * a random delimiter per line) rather than `name=value`, defensively — none
 * of today's values can contain a newline, but a future value shouldn't be
 * able to inject extra output lines either. */
function writeOutputs(result: ResolveResult, prNumber: number): void {
  const outputFile = requireEnv("GITHUB_OUTPUT");
  const entries: Record<string, string> = {
    should_run: String(result.shouldRun),
    pr_number: String(prNumber),
    head_ref: `refs/pull/${prNumber}/head`,
    trigger: result.trigger,
  };
  const lines = Object.entries(entries).map(([name, value]) => {
    const delimiter = `ghadelim_${crypto.randomUUID()}`;
    return `${name}<<${delimiter}\n${value}\n${delimiter}`;
  });
  // Append rather than overwrite: $GITHUB_OUTPUT may already carry lines from
  // earlier steps in the same job.
  appendFileSync(outputFile, `${lines.join("\n")}\n`);
}

/** Surfaces the skip reason (if any) in the job's step summary — the only
 * place it's actually read; it's not exposed as a job `outputs:` because
 * nothing downstream consumes it there. */
function writeStepSummary(result: ResolveResult): void {
  if (!result.skipReason) {
    return;
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) {
    return;
  }
  appendFileSync(summaryFile, `${result.skipReason}\n`);
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
      body: requireEnv("COMMENT_BODY"),
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
    `AI review resolve for PR #${prNumber}: should_run=${result.shouldRun} ` +
      `trigger=${result.trigger}${result.skipReason ? ` (${result.skipReason})` : ""}`,
  );

  writeOutputs(result, prNumber);
  writeStepSummary(result);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
