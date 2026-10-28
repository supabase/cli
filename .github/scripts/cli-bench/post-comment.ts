/**
 * Posts the CLI benchmark summary as the pull request's single marker comment.
 *
 * Runs in the one job that can write comments and treats the rendered markdown as untrusted data
 * (pull request code produced it): it reads a bounded regular file, neutralizes mentions, links and
 * HTML, adds the marker and the run link itself, truncates to GitHub's body limit, and creates or
 * updates the comment. Run in CI as: `bun .github/scripts/cli-bench/post-comment.ts`.
 *
 * Modes: `create-if-missing` leaves an existing marker comment alone unless it reports a failed
 * run (first run on a pull request); `upsert` updates it in place or creates it (`/bench`).
 */
import { lstatSync, readFileSync } from "node:fs";

import { githubFetch, requireEnv } from "./github.ts";

/** Hidden tag identifying the benchmark comment; the renderer in `bench-summary.ts` emits the same text. */
export const BENCH_MARKER = "<!-- cli-bench:pr -->";
/** Login of comments posted with the workflow's `GITHUB_TOKEN`. */
const WORKFLOW_BOT_LOGIN = "github-actions[bot]";
/** GitHub rejects comment bodies longer than 65536 characters. */
export const MAX_BODY_CHARS = 65_000;
const TRUNCATION_NOTICE =
  "\n\n</details>\n\n_The report was truncated; see the workflow run for the rest._\n";

export type Mode = "create-if-missing" | "upsert";

export interface ExistingComment {
  id: number;
  body: string;
  authorLogin: string;
}

export type CommentPlan = { kind: "skip" } | { kind: "create" } | { kind: "update"; id: number };

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

/** The comment body: the marker first, the sanitized report, then the trusted run link. */
export function prepareBody(markdown: string, runUrl?: string): string {
  const link = runUrl === undefined || runUrl === "" ? "" : `\n\n[Workflow run](${runUrl})\n`;
  const content = sanitize(markdown.replaceAll(BENCH_MARKER, "")).trim();
  const body = `${BENCH_MARKER}\n${content}\n`;
  const limit = MAX_BODY_CHARS - link.length;
  const fitted =
    body.length <= limit
      ? body
      : body.slice(0, limit - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
  return fitted + link;
}

/** What to do with the pull request's benchmark comment. Only the workflow bot's marker counts. */
export function planComment(mode: Mode, comments: ReadonlyArray<ExistingComment>): CommentPlan {
  const existing = comments.find(
    (comment) => comment.authorLogin === WORKFLOW_BOT_LOGIN && comment.body.includes(BENCH_MARKER),
  );
  if (existing === undefined) return { kind: "create" };
  // A first run that could not compare anything must not block the next push's real result.
  const replaceable = mode === "upsert" || existing.body.includes(FAILURE_TITLE);
  return replaceable ? { kind: "update", id: existing.id } : { kind: "skip" };
}

async function listComments(token: string, base: string, pr: number) {
  const comments: Array<ExistingComment> = [];
  for (let page = 1; ; page++) {
    const batch = (await (
      await githubFetch(`${base}/issues/${pr}/comments?per_page=100&page=${page}`, token)
    ).json()) as Array<{ id: number; body: string | null; user: { login: string } | null }>;
    comments.push(
      ...batch.map((entry) => ({
        id: entry.id,
        body: entry.body ?? "",
        authorLogin: entry.user?.login ?? "",
      })),
    );
    if (batch.length < 100) return comments;
  }
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
  const body = prepareBody(readFileSync(file, "utf8"), process.env.RUN_URL);

  const plan = planComment(mode, await listComments(token, base, pr));
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
