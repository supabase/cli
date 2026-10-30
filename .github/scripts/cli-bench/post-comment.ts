/**
 * Posts a CLI benchmark section into the pull request's single marker comment.
 *
 * The comment has one section per kind of run ("Lightweight Commands" and "Integration Heavy
 * Commands"). Each writer replaces only its own section, re-reads the comment to check that the
 * section landed, and retries when a concurrent writer overwrote it. Runs in the jobs that can
 * write comments and treats the rendered markdown as untrusted data (pull request code produced
 * it): it reads a bounded regular file, neutralizes mentions, links and HTML, adds the markers and
 * the run link itself, truncates to GitHub's body limit, and creates or updates the comment.
 * Run in CI as: `bun .github/scripts/cli-bench/post-comment.ts`.
 *
 * Modes: `create-if-missing` leaves a section that already reports a result alone (first run on a
 * pull request); `upsert` replaces it (a re-run or a command); `running` replaces it with a
 * placeholder that links to the run. Every result also goes into the history of earlier runs.
 */
import { lstatSync, readFileSync } from "node:fs";

import {
  getIssueComment,
  githubFetch,
  listIssueComments,
  requireEnv,
  type IssueComment,
} from "./github.ts";
import {
  decodeHistory,
  headlineOf,
  makeEntry,
  mergeHistory,
  renderHistory,
  SECTION_NAMES,
  SECTIONS,
  type RunEntry,
  type Section,
} from "./history.ts";

/** Hidden tag identifying the benchmark comment. */
export const BENCH_MARKER = "<!-- cli-bench:pr -->";
/** The one note under every comment, naming both commands. */
export const RERUN_NOTE =
  "Comment `/bench` (only includes lightweight benchmarks) or `/bench full` to run it again on the latest commit.";
/** Login of comments posted with the workflow's `GITHUB_TOKEN`. */
const WORKFLOW_BOT_LOGIN = "github-actions[bot]";
/** GitHub rejects comment bodies longer than 65536 characters. */
export const MAX_BODY_CHARS = 65_000;
const TRUNCATION_NOTICE =
  "\n\n</details>\n\n_The report was truncated; see the workflow run for the rest._\n";
/** Writes attempted before giving up on a section that keeps being overwritten. */
export const MAX_WRITE_ATTEMPTS = 3;

export type Mode = "create-if-missing" | "upsert" | "running";

export type ExistingComment = IssueComment;

export type CommentPlan =
  | { kind: "skip" }
  | { kind: "create" }
  | { kind: "update"; id: number; previousBody: string };

const ALLOWED_TAGS = new Set(["<details>", "</details>", "<summary>", "</summary>", "<br>"]);
const ZERO_WIDTH_SPACE = "​";
export const MAX_FILE_BYTES = 1_000_000;
const RUN_URL = /^https:\/\/[^\s)<>]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/u;

/** Keeps mentions, links, images and raw HTML in untrusted markdown from rendering. */
export function sanitize(markdown: string): string {
  return markdown
    .replaceAll("\\", "\\\\")
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

export interface SectionState {
  /** Short SHA of the commit the section measured. */
  sha: string;
  /** The section's Markdown, from its heading to its run link. */
  content: string;
}
export type Sections = Partial<Record<Section, SectionState>>;

const startMarker = (section: Section, sha: string) =>
  `<!-- cli-bench:section ${section} ${sha} -->`;
const endMarker = (section: Section) => `<!-- cli-bench:section-end ${section} -->`;

/** The sections recorded in a comment body. */
export function parseSections(body: string): Sections {
  const sections: Sections = {};
  for (const section of SECTIONS) {
    const match = new RegExp(
      `<!-- cli-bench:section ${section} ([0-9a-f]{7,40}) -->\\n([\\s\\S]*?)\\n${endMarker(section)}`,
      "u",
    ).exec(body);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      sections[section] = { sha: match[1], content: match[2] };
    }
  }
  return sections;
}

/** Whether a section's heading says the run produced no comparison. */
export const sectionFailed = (content: string) => /^### [^:\n]+: could not run$/mu.test(content);
const sectionRunning = (content: string) => /^### [^:\n]+: running$/mu.test(content);

const short = (sha: string) => sha.slice(0, 7);

/** The placeholder shown while a run is in progress. */
export function runningContent(
  section: Section,
  sha: string,
  now: Date,
  runUrl: string | undefined,
): string {
  const link = runUrl !== undefined && RUN_URL.test(runUrl) ? ` [Workflow run](${runUrl})` : "";
  return (
    `### ${SECTION_NAMES[section]}: running\n\n` +
    `Started ${now.toISOString().slice(0, 16).replace("T", " ")} UTC for commit \`${short(sha)}\`.${link}`
  );
}

/** The section for a run that produced no report. */
export function failureMarkdown(section: Section): string {
  return `### ${SECTION_NAMES[section]}: could not run\n\nThe benchmark did not finish. See the workflow run.`;
}

/** The sanitized report, then the trusted run link. */
export function sectionContent(markdown: string, runUrl: string | undefined): string {
  const content = sanitize(markdown.replaceAll(BENCH_MARKER, "")).trim();
  const link = runUrl !== undefined && RUN_URL.test(runUrl) ? `\n\n[Workflow run](${runUrl})` : "";
  return `${content}${link}`;
}

function assemble(sections: Sections, entries: ReadonlyArray<RunEntry>): string {
  const running = new Set(
    SECTIONS.filter((section) => {
      const state = sections[section];
      return state !== undefined && sectionRunning(state.content);
    }),
  );
  const blocks = SECTIONS.flatMap((section) => {
    const state = sections[section];
    return state === undefined
      ? []
      : [`${startMarker(section, state.sha)}\n${state.content}\n${endMarker(section)}`];
  });
  return (
    [
      BENCH_MARKER,
      "## CLI benchmark",
      ...blocks,
      RERUN_NOTE,
      renderHistory(entries, sanitize, running),
    ].join("\n\n") + "\n"
  );
}

/**
 * The comment body: the marker, each section, the re-run note, then the run history. `entries`
 * lists the newest run first; the oldest are dropped until the body fits, and then each section is
 * cut to its share of the limit.
 */
export function composeBody(sections: Sections, entries: ReadonlyArray<RunEntry> = []): string {
  for (let kept = entries.length; kept >= 0; kept--) {
    const body = assemble(sections, entries.slice(0, kept));
    if (body.length <= MAX_BODY_CHARS) return body;
  }
  const present = SECTIONS.filter((section) => sections[section] !== undefined);
  const overhead = assemble(
    Object.fromEntries(present.map((section) => [section, { sha: "0000000", content: "" }])),
    [],
  ).length;
  const share = Math.floor((MAX_BODY_CHARS - overhead) / Math.max(present.length, 1));
  const cut: Sections = {};
  for (const section of present) {
    const state = sections[section];
    if (state === undefined) continue;
    cut[section] = {
      sha: state.sha,
      content:
        state.content.length <= share
          ? state.content
          : state.content.slice(0, Math.max(0, share - TRUNCATION_NOTICE.length)) +
            TRUNCATION_NOTICE,
    };
  }
  return assemble(cut, []);
}

/** The workflow bot's benchmark comment, if any; the oldest wins when concurrent writers made two. */
export function findBenchComment(
  comments: ReadonlyArray<ExistingComment>,
): ExistingComment | undefined {
  return [...comments]
    .filter(
      (comment) =>
        comment.authorLogin === WORKFLOW_BOT_LOGIN && comment.body.includes(BENCH_MARKER),
    )
    .sort((a, b) => a.id - b.id)[0];
}

/** What to do with the pull request's benchmark comment for `section`. */
export function planComment(
  mode: Mode,
  section: Section,
  comments: ReadonlyArray<ExistingComment>,
): CommentPlan {
  const existing = findBenchComment(comments);
  if (existing === undefined) return { kind: "create" };
  const state = parseSections(existing.body)[section];
  // A first run that could not compare anything must not block the next push's real result.
  const replaceable =
    mode !== "create-if-missing" || state === undefined || sectionFailed(state.content);
  return replaceable
    ? { kind: "update", id: existing.id, previousBody: existing.body }
    : { kind: "skip" };
}

export interface CommentIo {
  list: () => Promise<ReadonlyArray<ExistingComment>>;
  get: (id: number) => Promise<ExistingComment | undefined>;
  create: (body: string) => Promise<number>;
  update: (id: number, body: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

export interface WriteInput {
  mode: Mode;
  section: Section;
  /** The commit the run measured. */
  sha: string;
  /** The rendered section; absent for `running`. */
  markdown: string | undefined;
  runUrl: string | undefined;
  now: Date;
}

export type WriteResult =
  | { kind: "skipped" }
  | { kind: "written"; id: number; created: boolean; attempts: number }
  | { kind: "unverified"; attempts: number };

/**
 * Writes `section` into the comment and verifies it by reading the comment back, retrying up to
 * {@link MAX_WRITE_ATTEMPTS} times when a concurrent writer overwrote it. A comment created while
 * another writer created one too is removed in favour of the older one.
 */
export async function writeSection(io: CommentIo, input: WriteInput): Promise<WriteResult> {
  const { mode, section } = input;
  const content =
    mode === "running" || input.markdown === undefined
      ? runningContent(section, input.sha, input.now, input.runUrl)
      : sectionContent(input.markdown, input.runUrl);
  const entry =
    mode === "running" || input.markdown === undefined
      ? undefined
      : makeEntry({
          section,
          sha: input.sha,
          now: input.now,
          headline: headlineOf(input.markdown),
          url: input.runUrl ?? "",
        });

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const plan = planComment(mode, section, await io.list());
    if (plan.kind === "skip") return { kind: "skipped" };
    const earlier = plan.kind === "update" ? plan.previousBody : "";
    const sections = parseSections(earlier);
    sections[section] = { sha: short(input.sha), content };
    const history = decodeHistory(earlier);
    const body = composeBody(
      sections,
      entry === undefined ? history : mergeHistory(history, entry),
    );

    let id: number;
    if (plan.kind === "update") {
      id = plan.id;
      await io.update(id, body);
    } else {
      id = await io.create(body);
    }

    const written = await io.get(id);
    // Compare with the section as composed, which may have been truncated to fit.
    const intended = parseSections(body)[section];
    const actual = written === undefined ? undefined : parseSections(written.body)[section];
    const landed =
      intended !== undefined && actual?.sha === intended.sha && actual.content === intended.content;
    if (plan.kind === "create") {
      const canonical = findBenchComment(await io.list());
      if (canonical !== undefined && canonical.id !== id) {
        await io.remove(id);
        continue;
      }
    }
    if (landed) return { kind: "written", id, created: plan.kind === "create", attempts: attempt };
  }
  return { kind: "unverified", attempts: MAX_WRITE_ATTEMPTS };
}

async function main(): Promise<void> {
  const token = requireEnv("GITHUB_TOKEN");
  const base = `https://api.github.com/repos/${requireEnv("GITHUB_REPOSITORY")}`;
  const pr = Number(requireEnv("PR_NUMBER"));
  const mode = requireEnv("MODE");
  if (mode !== "create-if-missing" && mode !== "upsert" && mode !== "running") {
    throw new Error(`Unsupported MODE "${mode}".`);
  }
  const section = process.env.SECTION ?? "lightweight";
  if (section !== "lightweight" && section !== "integration-heavy") {
    throw new Error(`Unsupported SECTION "${section}".`);
  }

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
      markdown = failureMarkdown(section);
    } else {
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw new Error("The benchmark comment file is not a regular file under the size limit.");
      }
      markdown = readFileSync(file, "utf8");
    }
  }

  const io: CommentIo = {
    list: () => listIssueComments(token, base, pr),
    get: (id) => getIssueComment(token, base, id),
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
    remove: async (id) => {
      await githubFetch(`${base}/issues/comments/${id}`, token, { method: "DELETE" });
    },
  };

  const result = await writeSection(io, {
    mode,
    section,
    sha: requireEnv("HEAD_SHA"),
    markdown,
    runUrl: process.env.RUN_URL,
    now: new Date(),
  });
  if (result.kind === "skipped") {
    console.log(`PR #${pr} already has a ${section} result; leaving it untouched.`);
  } else if (result.kind === "written") {
    console.log(
      `${result.created ? "Created" : "Updated"} benchmark comment ${result.id} on PR #${pr} (${section}).`,
    );
  } else {
    throw new Error(
      `The ${section} section did not land after ${result.attempts} attempts; another writer kept replacing it.`,
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
