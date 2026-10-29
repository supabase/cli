/**
 * Posts the CLI benchmark summary as the pull request's single marker comment.
 *
 * Runs in the one job that can write comments and treats the rendered markdown as untrusted data
 * (pull request code produced it): it reads a bounded regular file, neutralizes mentions, links and
 * HTML, adds the marker and the run link itself, truncates to GitHub's body limit, and creates or
 * updates the comment. Run in CI as: `bun .github/scripts/cli-bench/post-comment.ts`.
 *
 * Modes: `create-if-missing` leaves an existing marker comment alone unless it reports a failed
 * run (first run on a pull request); `upsert` updates it in place or creates it (a re-run).
 * Every post also records the run in the comment's history of earlier runs.
 */
import { lstatSync, readFileSync } from "node:fs";

import { githubFetch, listIssueComments, requireEnv, type IssueComment } from "./github.ts";
import { decodeHistory, headlineOf, makeEntry, mergeHistory, renderHistory } from "./history.ts";
import type { RunEntry } from "./history.ts";

/** Hidden tag identifying the benchmark comment; the renderer in `bench-summary.ts` emits the same text. */
export const BENCH_MARKER = "<!-- cli-bench:pr -->";
/** Login of comments posted with the workflow's `GITHUB_TOKEN`. */
const WORKFLOW_BOT_LOGIN = "github-actions[bot]";
/** GitHub rejects comment bodies longer than 65536 characters. */
export const MAX_BODY_CHARS = 65_000;
const TRUNCATION_NOTICE =
  "\n\n</details>\n\n_The report was truncated; see the workflow run for the rest._\n";

export type Mode = "create-if-missing" | "upsert";

export type ExistingComment = IssueComment;

export type CommentPlan =
  | { kind: "skip" }
  | { kind: "create" }
  | { kind: "update"; id: number; previousBody: string };

const ALLOWED_TAGS = new Set(["<details>", "</details>", "<summary>", "</summary>", "<br>"]);
const ZERO_WIDTH_SPACE = "\u200b";
/** Title the renderer gives a run that produced no comparison. */
export const FAILURE_TITLE = "## CLI benchmark: could not run";
export const MAX_FILE_BYTES = 1_000_000;

/** Keeps mentions, links, images and raw HTML in untrusted markdown from rendering. */
export function sanitize(markdown: string): string {
  return markdown
    .replaceAll("&", "&amp;")
    .replaceAll(/<[^>\n]*>?/gu, (tag) =>
      ALLOWED_TAGS.has(tag) ? tag : tag.replaceAll("<", "&lt;"),
    )
    .replaceAll("@", `@${ZERO_WIDTH_SPACE}`)
    .replaceAll("://", `:${ZERO_WIDTH_SPACE}//`)
    .replaceAll(/\b(www)\./giu, `$1${ZERO_WIDTH_SPACE}.`)
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

/**
 * The comment body: the marker first, the sanitized report, the trusted run link, then the run
 * history. `history` lists the current run first; the oldest runs are dropped until the body fits.
 */
export function prepareBody(
  markdown: string,
  runUrl?: string,
  history: ReadonlyArray<RunEntry> = [],
): string {
  const link = runUrl === undefined || runUrl === "" ? "" : `\n\n[Workflow run](${runUrl})\n`;
  const content = sanitize(markdown.replaceAll(BENCH_MARKER, "")).trim();
  const body = `${BENCH_MARKER}\n${content}\n`;
  for (let kept = history.length; kept >= 1; kept--) {
    const tail = `${link}\n${renderHistory(history.slice(0, kept), sanitize)}\n`;
    if (body.length + tail.length <= MAX_BODY_CHARS) return body + tail;
  }
  const tail = `${link}\n${history.length === 0 ? "" : `${renderHistory(history.slice(0, 1), sanitize)}\n`}`;
  const limit = MAX_BODY_CHARS - tail.length;
  const fitted =
    body.length <= limit
      ? body
      : body.slice(0, limit - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
  return fitted + tail;
}

/** The workflow bot's benchmark comment, if any. Only its marker counts. */
export function findBenchComment(
  comments: ReadonlyArray<ExistingComment>,
): ExistingComment | undefined {
  return comments.find(
    (comment) => comment.authorLogin === WORKFLOW_BOT_LOGIN && comment.body.includes(BENCH_MARKER),
  );
}

/** What to do with the pull request's benchmark comment. */
export function planComment(mode: Mode, comments: ReadonlyArray<ExistingComment>): CommentPlan {
  const existing = findBenchComment(comments);
  if (existing === undefined) return { kind: "create" };
  // A first run that could not compare anything must not block the next push's real result.
  const replaceable = mode === "upsert" || existing.body.includes(FAILURE_TITLE);
  return replaceable
    ? { kind: "update", id: existing.id, previousBody: existing.body }
    : { kind: "skip" };
}

async function main(): Promise<void> {
  const token = requireEnv("GITHUB_TOKEN");
  const base = `https://api.github.com/repos/${requireEnv("GITHUB_REPOSITORY")}`;
  const pr = Number(requireEnv("PR_NUMBER"));
  const mode = requireEnv("MODE");
  if (mode !== "create-if-missing" && mode !== "upsert") {
    throw new Error(`Unsupported MODE "${mode}".`);
  }
  const file = requireEnv("BODY_FILE");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw new Error("The benchmark comment file is not a regular file under the size limit.");
  }
  const markdown = readFileSync(file, "utf8");
  const runUrl = process.env.RUN_URL;
  const entry = makeEntry({
    sha: requireEnv("HEAD_SHA"),
    now: new Date(),
    headline: headlineOf(markdown),
    url: runUrl ?? "",
  });

  const plan = planComment(mode, await listIssueComments(token, base, pr));
  const earlier = plan.kind === "update" ? decodeHistory(plan.previousBody) : [];
  const body = prepareBody(
    markdown,
    runUrl,
    entry === undefined ? [] : mergeHistory(earlier, entry),
  );
  if (plan.kind === "skip") {
    console.log(`PR #${pr} already has a benchmark comment; leaving it untouched.`);
  } else if (plan.kind === "update") {
    await githubFetch(`${base}/issues/comments/${plan.id}`, token, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    console.log(`Updated benchmark comment ${plan.id} on PR #${pr}.`);
  } else {
    await githubFetch(`${base}/issues/${pr}/comments`, token, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    console.log(`Created benchmark comment on PR #${pr}.`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
