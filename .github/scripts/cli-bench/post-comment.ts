/**
 * Posts one CLI benchmark report as its own pull request comment.
 *
 * Each kind of run owns a comment identified by a hidden marker: the lightweight benchmark and
 * the integration-heavy (full) benchmark never touch each other's comment. Runs in the jobs that
 * can write comments and treats the rendered markdown as untrusted data (pull request code
 * produced it): it reads a bounded regular file, neutralizes mentions, links and HTML, adds the
 * marker, the re-run note and the run link itself, truncates to GitHub's body limit, and creates
 * or updates the comment. Run in CI as: `bun .github/scripts/cli-bench/post-comment.ts`.
 *
 * Modes: `create-if-missing` leaves an existing comment alone unless it reports a failed run
 * (first run on a pull request); `upsert` updates it in place or creates it; `running` replaces
 * the current result with a placeholder that links to the run. Every result also goes into the
 * comment's history of earlier runs. The workflow serializes the writers of one comment.
 */
import { lstatSync, readFileSync } from "node:fs";

import { githubFetch, listIssueComments, requireEnv, type IssueComment } from "./github.ts";
import {
  decodeHistory,
  headlineOf,
  makeEntry,
  mergeHistory,
  MAX_PREVIOUS_RUNS,
  renderHistory,
  type RunEntry,
} from "./history.ts";

/** The two comments a pull request can have. */
export type Kind = "lightweight" | "integration-heavy";

/** Hidden tags identifying each comment; the lightweight one is the original benchmark marker. */
export const MARKERS: Record<Kind, string> = {
  lightweight: "<!-- cli-bench:pr -->",
  "integration-heavy": "<!-- cli-bench:full -->",
};
/** The line under each comment telling readers which command re-runs what. */
export const RERUN_NOTES: Record<Kind, string> = {
  lightweight:
    "Comment `/bench` to run the lightweight benchmark (this comment) again on the latest commit, or `/bench full` to also run the integration-heavy benchmark, which posts in its own comment.",
  "integration-heavy":
    "Comment `/bench full` to run this benchmark again on the latest commit, which also refreshes the lightweight comment if it is behind. `/bench` runs only the lightweight benchmark.",
};
const TITLES: Record<Kind, string> = {
  lightweight: "## CLI benchmark",
  "integration-heavy": "## CLI benchmark (Integration Heavy Commands)",
};
/** Login of comments posted with the workflow's `GITHUB_TOKEN`. */
const WORKFLOW_BOT_LOGIN = "github-actions[bot]";
/** GitHub rejects comment bodies longer than 65536 characters. */
export const MAX_BODY_CHARS = 65_000;
const TRUNCATION_NOTICE =
  "\n\n</details>\n\n_The report was truncated; see the workflow run for the rest._\n";

export type Mode = "create-if-missing" | "upsert" | "running";

export type ExistingComment = IssueComment;

const ALLOWED_TAGS = new Set(["<details>", "</details>", "<summary>", "</summary>", "<br>"]);
const ZERO_WIDTH_SPACE = "\u200b";
export const MAX_FILE_BYTES = 1_000_000;
const RUN_URL = /^https:\/\/[^\s)<>]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/u;

/** Keeps mentions, links, images and raw HTML in untrusted markdown from rendering. */
export function sanitize(markdown: string): string {
  return markdown
    .replaceAll("\\", "\\\\")
    .replaceAll("\\\\|", "\\|")
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

const short = (sha: string) => sha.slice(0, 7);
const runLink = (runUrl: string | undefined) =>
  runUrl !== undefined && RUN_URL.test(runUrl) ? ` [Workflow run](${runUrl})` : "";

/** Whether a comment reports a run that produced no comparison. */
export const commentFailed = (body: string) =>
  /^## CLI benchmark[^\n]*: could not run$/mu.test(body);

/** The placeholder shown while a run is in progress. */
export function runningContent(
  kind: Kind,
  sha: string,
  now: Date,
  runUrl: string | undefined,
): string {
  return (
    `${TITLES[kind]}: running\n\n` +
    `Started ${now.toISOString().slice(0, 16).replace("T", " ")} UTC for commit \`${short(sha)}\`.${runLink(runUrl)}`
  );
}

/** The report for a run that produced none. */
export function failureMarkdown(kind: Kind, sha: string): string {
  return `${TITLES[kind]}: could not run\n\nThe benchmark did not finish for commit \`${short(sha)}\`. See the workflow run.`;
}

/** The sanitized report, then the trusted run link. */
export function reportContent(markdown: string, runUrl: string | undefined): string {
  const stripped = Object.values(MARKERS).reduce(
    (text, marker) => text.replaceAll(marker, ""),
    markdown,
  );
  const link = runUrl !== undefined && RUN_URL.test(runUrl) ? `\n\n[Workflow run](${runUrl})` : "";
  return `${sanitize(stripped).trim()}${link}`;
}

/**
 * The short SHA of the commit a comment's newest result measured, or undefined when the comment
 * reports a failed or running benchmark or has no recorded result.
 */
export function measuredSha(body: string): string | undefined {
  if (commentFailed(body) || /^## CLI benchmark[^\n]*: running$/mu.test(body)) return undefined;
  return decodeHistory(body)[0]?.sha;
}

function assemble(
  kind: Kind,
  content: string,
  entries: ReadonlyArray<RunEntry>,
  running: boolean,
): string {
  return (
    [MARKERS[kind], content, RERUN_NOTES[kind], renderHistory(entries, sanitize, running)].join(
      "\n\n",
    ) + "\n"
  );
}

/**
 * The comment body: the marker, the report, the re-run note, then the run history. `entries`
 * lists the newest run first; the oldest are dropped until the body fits, always keeping the
 * newest, and only then is the report cut.
 */
export function composeBody(
  kind: Kind,
  content: string,
  entries: ReadonlyArray<RunEntry> = [],
  running = false,
): string {
  const shown = running ? entries.slice(0, MAX_PREVIOUS_RUNS) : entries;
  for (let kept = shown.length; kept >= 1; kept--) {
    const body = assemble(kind, content, shown.slice(0, kept), running);
    if (body.length <= MAX_BODY_CHARS) return body;
  }
  const newest = shown.slice(0, 1);
  const limit = MAX_BODY_CHARS - assemble(kind, "", newest, running).length;
  const fitted =
    content.length <= limit
      ? content
      : content.slice(0, Math.max(0, limit - TRUNCATION_NOTICE.length)) + TRUNCATION_NOTICE;
  return assemble(kind, fitted, newest, running);
}

/** The workflow bot's comment for `kind`, if any; the oldest wins should two exist. */
export function findComment(
  kind: Kind,
  comments: ReadonlyArray<ExistingComment>,
): ExistingComment | undefined {
  return [...comments]
    .filter(
      (comment) =>
        comment.authorLogin === WORKFLOW_BOT_LOGIN && comment.body.includes(MARKERS[kind]),
    )
    .sort((a, b) => a.id - b.id)[0];
}

export interface CommentIo {
  list: () => Promise<ReadonlyArray<ExistingComment>>;
  create: (body: string) => Promise<number>;
  update: (id: number, body: string) => Promise<void>;
}

export interface WriteInput {
  mode: Mode;
  kind: Kind;
  /** The commit the run measured. */
  sha: string;
  /** The rendered report; absent for `running`. */
  markdown: string | undefined;
  runUrl: string | undefined;
  now: Date;
}

export type WriteResult = { kind: "skipped" } | { kind: "written"; id: number; created: boolean };

/** Writes the comment for `input.kind`, carrying its history on; no other comment is read or changed. */
export async function writeComment(io: CommentIo, input: WriteInput): Promise<WriteResult> {
  const { mode, kind } = input;
  const existing = findComment(kind, await io.list());
  if (mode === "create-if-missing" && existing !== undefined && !commentFailed(existing.body)) {
    return { kind: "skipped" };
  }
  const running = mode === "running" || input.markdown === undefined;
  const history = decodeHistory(existing?.body ?? "");
  const entry = running
    ? undefined
    : makeEntry({
        sha: input.sha,
        now: input.now,
        headline: headlineOf(input.markdown ?? ""),
        url: input.runUrl ?? "",
      });
  const content = running
    ? runningContent(kind, input.sha, input.now, input.runUrl)
    : reportContent(input.markdown ?? "", input.runUrl);
  const body = composeBody(
    kind,
    content,
    entry === undefined ? history : mergeHistory(history, entry),
    running,
  );
  if (existing === undefined) {
    return { kind: "written", id: await io.create(body), created: true };
  }
  await io.update(existing.id, body);
  return { kind: "written", id: existing.id, created: false };
}

async function main(): Promise<void> {
  const token = requireEnv("GITHUB_TOKEN");
  const base = `https://api.github.com/repos/${requireEnv("GITHUB_REPOSITORY")}`;
  const pr = Number(requireEnv("PR_NUMBER"));
  const mode = requireEnv("MODE");
  if (mode !== "create-if-missing" && mode !== "upsert" && mode !== "running") {
    throw new Error(`Unsupported MODE "${mode}".`);
  }
  const kind = process.env.KIND ?? "lightweight";
  if (kind !== "lightweight" && kind !== "integration-heavy") {
    throw new Error(`Unsupported KIND "${kind}".`);
  }
  const sha = requireEnv("HEAD_SHA");

  let markdown: string | undefined;
  if (mode !== "running") {
    const file = requireEnv("BODY_FILE");
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(file);
    } catch {
      stat = undefined;
    }
    if (stat === undefined) {
      if (process.env.MISSING_BODY !== "failure") {
        console.log("The benchmark job produced no comment.");
        return;
      }
      markdown = failureMarkdown(kind, sha);
    } else {
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw new Error("The benchmark comment file is not a regular file under the size limit.");
      }
      markdown = readFileSync(file, "utf8");
    }
  }

  const io: CommentIo = {
    list: () => listIssueComments(token, base, pr),
    create: async (body) => {
      const created = (await (
        await githubFetch(`${base}/issues/${pr}/comments`, token, {
          method: "POST",
          body: JSON.stringify({ body }),
        })
      ).json()) as { id: number };
      return created.id;
    },
    update: async (id, body) => {
      await githubFetch(`${base}/issues/comments/${id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
    },
  };

  const result = await writeComment(io, {
    mode,
    kind,
    sha,
    markdown,
    runUrl: process.env.RUN_URL,
    now: new Date(),
  });
  console.log(
    result.kind === "skipped"
      ? `PR #${pr} already has a ${kind} result; leaving it untouched.`
      : `${result.created ? "Created" : "Updated"} ${kind} benchmark comment ${result.id} on PR #${pr}.`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
