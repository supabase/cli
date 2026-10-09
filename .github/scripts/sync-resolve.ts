import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  type GitRunner,
  RELEASE_BOT_LOGIN,
  githubRequest,
  gitOrThrow,
  makeGit,
  requireEnv,
} from "./promotion-shared.ts";
import {
  PROTECTED_PATH_PREFIX,
  type ResolutionPlan,
  protectedPathChanges,
  syncBranchName,
} from "./sync-branches.ts";

export interface AgentResolution {
  status: "resolved" | "unresolved";
  summary: string;
  files: { path: string; resolution: string; precedent: number | null }[];
  deletedFiles: string[];
  decisions: { paths: string[]; question: string; chosen: string; alternative: string }[];
}

export interface MergeRecord {
  ref: string;
  sha: string;
  /** Null when the merge was clean. */
  resolution: AgentResolution | null;
}

/** Outcome of formatting and type-checking the merged tree, after at most one agent fix. */
export interface CheckResult {
  passed: boolean;
  /** Files the formatter or the agent changed after the merge, folded into the last merge commit. */
  fixes: AgentResolution["files"];
  /** Choices the agent made while fixing type errors. */
  decisions: AgentResolution["decisions"];
  /** Type checker output still failing, capped. */
  remaining?: string;
}

export type ResolveResult =
  | { status: "resolved"; head: string; merges: MergeRecord[]; check?: CheckResult }
  | { status: "manual"; reason: string; ref: string; sha: string; files: string[] };

export interface Conflict {
  ref: string;
  sha: string;
  /** The files this agent call resolves. */
  files: string[];
  /** Every conflicted file of the merge; the other groups are resolved by separate calls. */
  allFiles: string[];
  group: number;
  groups: number;
  /** Why the previous attempt on this group was rejected, if this is a retry. */
  previousFailure?: string;
}

/** Returns the agent's resolution, or the reason it produced none. */
export type ConflictResolver = (conflict: Conflict) => Promise<AgentResolution | string>;

/** Marks the bot comment that records one run's resolution; later runs read these as precedent. */
export const RESOLUTION_MARKER = "<!-- sync-resolution -->";

const MAX_AGENT_ATTEMPTS = 2;
/** Small enough that one agent call resolves a group within its turn budget. */
const MAX_GROUP_SIZE = 8;
const CONFLICT_MARKER = /^(<{7}|\|{7}|>{7})( |$)/m;
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function short(sha: string): string {
  return sha.slice(0, 7);
}

function unmergedFiles(git: GitRunner): string[] {
  return [
    ...new Set(
      gitOrThrow(git, ["diff", "-z", "--name-only", "--diff-filter=U"]).split("\0").filter(Boolean),
    ),
  ];
}

/** Splits conflicted files into groups of neighbouring paths, so related files share one agent call. */
export function groupConflicts(files: string[], size = MAX_GROUP_SIZE): string[][] {
  const sorted = [...files].sort();
  const groups: string[][] = [];
  for (let index = 0; index < sorted.length; index += size) {
    groups.push(sorted.slice(index, index + size));
  }
  return groups;
}

function checkGroup(
  workDir: string,
  files: string[],
  resolution: AgentResolution,
): string | undefined {
  if (resolution.status === "unresolved") {
    return `The agent left the conflicts unresolved: ${resolution.summary}`;
  }
  const strayDeletion = resolution.deletedFiles.find((path) => !files.includes(path));
  if (strayDeletion !== undefined) {
    return `The agent asked to delete \`${strayDeletion}\`, which is not in its group.`;
  }
  for (const path of files.filter((file) => !resolution.deletedFiles.includes(file))) {
    const file = join(workDir, path);
    if (!existsSync(file)) {
      return `\`${path}\` is missing; deletions must be listed in \`deletedFiles\`.`;
    }
    if (CONFLICT_MARKER.test(readFileSync(file, "utf8"))) {
      return `\`${path}\` still contains conflict markers.`;
    }
  }
  return undefined;
}

function combine(resolutions: AgentResolution[]): AgentResolution {
  return {
    status: "resolved",
    summary: resolutions.map(({ summary }) => summary).join(" "),
    files: resolutions.flatMap(({ files }) => files),
    deletedFiles: resolutions.flatMap(({ deletedFiles }) => deletedFiles),
    decisions: resolutions.flatMap(({ decisions }) => decisions),
  };
}

/** Replays the plan's merges onto its base, asking `resolver` to finish each group of conflicted files. */
export async function replayMerges(
  git: GitRunner,
  workDir: string,
  plan: ResolutionPlan,
  resolver: ConflictResolver,
): Promise<ResolveResult> {
  const syncBranch = syncBranchName(plan);
  gitOrThrow(git, ["checkout", "--detach", plan.base]);
  const merges: MergeRecord[] = [];

  for (const { ref, sha } of plan.merges) {
    const before = gitOrThrow(git, ["rev-parse", "HEAD"]);
    const message = `Merge ${ref} (${short(sha)}) into ${syncBranch}`;
    const merge = git(["-c", "merge.conflictStyle=zdiff3", "merge", "--no-ff", "-m", message, sha]);
    if (merge.status === 0) {
      merges.push({ ref, sha, resolution: null });
      continue;
    }
    const allFiles = unmergedFiles(git);
    if (allFiles.length === 0) {
      throw new Error(`git merge failed without conflicts: ${merge.stderr || merge.stdout}`);
    }
    const giveUp = (reason: string): ResolveResult => {
      git(["merge", "--abort"]);
      gitOrThrow(git, ["reset", "--hard", before]);
      gitOrThrow(git, ["clean", "-fd"]);
      return { status: "manual", reason, ref, sha, files: allFiles };
    };

    const groups = groupConflicts(allFiles);
    const resolutions: AgentResolution[] = [];
    for (const [index, files] of groups.entries()) {
      let failure: string | undefined;
      let resolution: AgentResolution | undefined;
      for (let attempt = 1; attempt <= MAX_AGENT_ATTEMPTS && !resolution; attempt += 1) {
        const outcome = await resolver({
          ref,
          sha,
          files,
          allFiles,
          group: index + 1,
          groups: groups.length,
          ...(failure ? { previousFailure: failure } : {}),
        });
        failure = typeof outcome === "string" ? outcome : checkGroup(workDir, files, outcome);
        if (failure === undefined && typeof outcome !== "string") {
          resolution = outcome;
        }
      }
      if (!resolution) {
        return giveUp(`Group ${index + 1} of ${groups.length}: ${failure}`);
      }
      resolutions.push(resolution);
    }

    const combined = combine(resolutions);
    for (const path of combined.deletedFiles) {
      gitOrThrow(git, ["rm", "-q", "--ignore-unmatch", "--", path]);
    }
    gitOrThrow(git, ["add", "-A"]);
    gitOrThrow(git, ["commit", "--no-verify", "-m", message]);
    const { strayEdits } = protectedPathChanges(git, "HEAD");
    if (strayEdits.length > 0) {
      return giveUp(
        `The agent edited \`${strayEdits.join("`, `")}\`, which did not conflict; files under \`${PROTECTED_PATH_PREFIX}\` may change only to resolve a conflict.`,
      );
    }
    merges.push({ ref, sha, resolution: combined });
  }

  return { status: "resolved", head: gitOrThrow(git, ["rev-parse", "HEAD"]), merges };
}

export type TypeChecker = () => { passed: boolean; output: string };

/** Returns the agent's fix for the type checker output, or the reason it produced none. */
export type TypeErrorFixer = (output: string) => Promise<AgentResolution | string>;

const MAX_CHECK_OUTPUT = 20_000;

function discardWorktreeChanges(git: GitRunner, commit: string): void {
  gitOrThrow(git, ["reset", "-q", "--hard", commit]);
  gitOrThrow(git, ["clean", "-fdq"]);
}

const FORMATTED = "Formatted with the repository formatter.";

/**
 * Amends the tracked-file changes the check left, the formatter's, into HEAD and drops anything else. Formatting
 * that touches a protected path that did not conflict is dropped too.
 */
function keepFormatting(git: GitRunner): AgentResolution["files"] {
  const head = gitOrThrow(git, ["rev-parse", "HEAD"]);
  gitOrThrow(git, ["add", "-u"]);
  const files = gitOrThrow(git, ["diff", "--cached", "-z", "--name-only"])
    .split("\0")
    .filter(Boolean);
  if (files.length > 0) {
    gitOrThrow(git, ["commit", "-q", "--amend", "--no-edit", "--no-verify"]);
    if (protectedPathChanges(git, "HEAD").strayEdits.length > 0) {
      discardWorktreeChanges(git, head);
      return [];
    }
  }
  discardWorktreeChanges(git, gitOrThrow(git, ["rev-parse", "HEAD"]));
  return files.map((path) => ({ path, resolution: FORMATTED, precedent: null }));
}

/**
 * Formats and type-checks the merged tree and, when the type check fails, asks `fix` for one round of edits. Every
 * change is amended into the last merge commit so the history stays exactly the planned merges; a rejected fix is
 * dropped.
 */
export async function checkAndFix(
  git: GitRunner,
  check: TypeChecker,
  fix: TypeErrorFixer,
): Promise<CheckResult> {
  const first = check();
  const formatted = keepFormatting(git);
  if (first.passed) {
    return { passed: true, fixes: formatted, decisions: [] };
  }
  const failed = (
    output: string,
    fixes: AgentResolution["files"],
    decisions: AgentResolution["decisions"] = [],
  ): CheckResult => ({
    passed: false,
    fixes,
    decisions,
    remaining: output.slice(-MAX_CHECK_OUTPUT),
  });

  const before = gitOrThrow(git, ["rev-parse", "HEAD"]);
  const outcome = await fix(first.output.slice(-MAX_CHECK_OUTPUT));
  if (
    typeof outcome === "string" ||
    outcome.status === "unresolved" ||
    outcome.deletedFiles.length > 0
  ) {
    discardWorktreeChanges(git, before);
    return failed(first.output, formatted);
  }
  gitOrThrow(git, ["add", "-A"]);
  gitOrThrow(git, ["commit", "-q", "--amend", "--no-edit", "--no-verify"]);
  if (protectedPathChanges(git, "HEAD").strayEdits.length > 0) {
    discardWorktreeChanges(git, before);
    return failed(first.output, formatted);
  }

  const second = check();
  const edited = new Set(outcome.files.map(({ path }) => path));
  const fixes = [
    ...outcome.files,
    ...[...formatted, ...keepFormatting(git)].filter(({ path }) => !edited.has(path)),
  ].filter((fix, index, all) => all.findIndex(({ path }) => path === fix.path) === index);
  return second.passed
    ? { passed: true, fixes, decisions: outcome.decisions }
    : failed(second.output, fixes, outcome.decisions);
}

async function withTypeCheck(
  git: GitRunner,
  result: Extract<ResolveResult, { status: "resolved" }>,
  check: TypeChecker,
  fix: TypeErrorFixer,
): Promise<ResolveResult> {
  const outcome = await checkAndFix(git, check, fix);
  return { ...result, head: gitOrThrow(git, ["rev-parse", "HEAD"]), check: outcome };
}

/**
 * Runs the repository formatter, then its type check, in a container with no credentials, since the tree holds
 * agent edits and the install runs package code. Ignored output such as `node_modules` stays for the next check.
 */
export function runChecks(workDir: string, image: string): { passed: boolean; output: string } {
  const home = mkdtempSync(join(tmpdir(), "sync-check-home-"));
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const pnpm = JSON.parse(readFileSync(join(workDir, "package.json"), "utf8")).devEngines
    ?.packageManager?.version as string | undefined;
  console.log("Formatting and type-checking the merged tree…");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      user,
      "--env",
      "HOME=/home/check",
      "--env",
      "CI=true",
      "--volume",
      `${workDir}:/work`,
      "--volume",
      `${join(workDir, ".git")}:/work/.git:ro`,
      "--volume",
      `${home}:/home/check`,
      "--workdir",
      "/work",
      image,
      "sh",
      "-c",
      [
        `npm install -g --silent --prefix /home/check/npm pnpm@${pnpm ?? "latest"}`,
        "export PATH=/home/check/npm/bin:$PATH",
        "pnpm install --frozen-lockfile --ignore-scripts --reporter=silent",
        "pnpm run --silent fmt:fix",
        "pnpm exec turbo run types:check --output-logs=errors-only",
      ].join(" && "),
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const passed = result.status === 0;
  console.log(passed ? "Type check passed." : `Type check failed (status ${result.status}).`);
  return { passed, output };
}

function capLines(text: string, max: number): string {
  const lines = text.split("\n");
  return lines.length <= max
    ? text
    : [...lines.slice(0, max), `… ${lines.length - max} more lines`].join("\n");
}

function fenced(text: string, language = ""): string {
  return ["````" + language, text, "````"].join("\n");
}

export interface PrecedentCommit {
  sha: string;
  pullRequest: number;
  isMerge: boolean;
}

/** Writes the per-file history each side brought into this conflict, plus earlier resolutions of the same files. */
export function writeConflictContext(
  git: GitRunner,
  path: string,
  conflict: Conflict,
  precedentCommits: PrecedentCommit[],
): void {
  const mergeBase = gitOrThrow(git, ["merge-base", "HEAD", conflict.sha]);
  const sections = [
    `# Merging \`${conflict.ref}\` (\`${short(conflict.sha)}\`) into HEAD`,
    "",
    `Common ancestor: \`${short(mergeBase)}\`.`,
  ];
  for (const file of conflict.files) {
    const side = (tip: string) => ({
      log: git(["log", "--format=- %h %an: %s", "-n", "30", `${mergeBase}..${tip}`, "--", file])
        .stdout,
      diff: git(["diff", mergeBase, tip, "--", file]).stdout,
    });
    const head = side("HEAD");
    const incoming = side(conflict.sha);
    const earlier = precedentCommits
      .map(({ sha, pullRequest, isMerge }) => {
        const shown = git([
          "show",
          ...(isMerge ? ["--remerge-diff"] : []),
          `--format=#### ${isMerge ? "Resolution" : "Maintainer fix"} %h from #${pullRequest}`,
          sha,
          "--",
          file,
        ]).stdout;
        return shown.includes("\ndiff ") ? capLines(shown, 200) : "";
      })
      .filter(Boolean)
      .slice(0, 5);
    sections.push(
      "",
      `## \`${file}\``,
      "",
      "### HEAD side commits",
      head.log || "(none)",
      "",
      `### \`${conflict.ref}\` side commits`,
      incoming.log || "(none)",
      "",
      "### HEAD side diff from the ancestor",
      fenced(capLines(head.diff, 400), "diff"),
      "",
      `### \`${conflict.ref}\` side diff from the ancestor`,
      fenced(capLines(incoming.diff, 400), "diff"),
      "",
      "### Earlier resolutions of this file",
      ...(earlier.length > 0 ? earlier.map((text) => fenced(text, "diff")) : ["(none)"]),
    );
  }
  writeFileSync(path, `${sections.join("\n")}\n`);
}

interface GithubUser {
  login: string;
  type: string;
}

interface PullRequestSummary {
  number: number;
  state: string;
  merged_at: string | null;
  head: { sha: string };
  base: { sha: string };
}

interface Remark {
  user: GithubUser | null;
  author_association: string;
  body: string | null;
  state?: string;
  path?: string;
}

export type GithubGet = (path: string) => Promise<unknown>;

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

async function getAll<T>(get: GithubGet, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = (await get(`${path}?per_page=${PAGE_SIZE}&page=${page}`)) as T[];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) {
      break;
    }
  }
  return items;
}

/**
 * Commits a sync pull request added beyond the source and the target it started from: the merges that resolved
 * conflicts and any fix a maintainer pushed. Empty when the head is not available locally.
 */
function resolutionCommits(
  git: GitRunner,
  pull: PullRequestSummary,
  source: string,
): { sha: string; isMerge: boolean; subject: string; author: string }[] {
  const log = git([
    "log",
    "--format=%H%x1f%P%x1f%an%x1f%s",
    pull.head.sha,
    `^${pull.base.sha}`,
    `^refs/remotes/origin/${source}`,
  ]);
  if (log.status !== 0) {
    return [];
  }
  return log.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", parents = "", author = "", subject = ""] = line.split("\x1f");
      return { sha, isMerge: parents.split(" ").length > 1, subject, author };
    });
}

function byMaintainer(remark: Remark): boolean {
  return remark.user?.type !== "Bot" && TRUSTED_ASSOCIATIONS.has(remark.author_association);
}

function isMaintainerRemark(remark: Remark): boolean {
  return byMaintainer(remark) && Boolean(remark.body?.trim());
}

function isResolutionRecord(remark: Remark): boolean {
  return (
    remark.user?.login === RELEASE_BOT_LOGIN && Boolean(remark.body?.includes(RESOLUTION_MARKER))
  );
}

function quote(body: string): string {
  const text = body.length > 4000 ? `${body.slice(0, 4000)}…` : body;
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Collects earlier sync pull requests for the agent: recorded resolutions, maintainer remarks, and the commits
 * that landed. Remarks from anyone without write-level association are left out, since anyone can comment.
 */
export async function gatherPrecedents(
  get: GithubGet,
  git: GitRunner,
  repository: string,
  plan: ResolutionPlan,
): Promise<{ markdown: string; commits: PrecedentCommit[] }> {
  const owner = repository.split("/")[0] ?? "";
  const query = new URLSearchParams({
    state: "all",
    head: `${owner}:${syncBranchName(plan)}`,
    base: plan.target,
    sort: "created",
    direction: "desc",
    per_page: "20",
  });
  const pulls = (await get(`/repos/${repository}/pulls?${query}`)) as PullRequestSummary[];
  const commits: PrecedentCommit[] = [];
  const sections = [
    "# Earlier sync pull requests",
    "",
    "Newest first. A landed pull request's resolutions were approved; maintainer remarks and fix commits override the agent records they answer.",
  ];

  for (const pull of pulls) {
    const [comments, reviews, reviewComments] = await Promise.all([
      getAll<Remark>(get, `/repos/${repository}/issues/${pull.number}/comments`),
      getAll<Remark>(get, `/repos/${repository}/pulls/${pull.number}/reviews`),
      getAll<Remark>(get, `/repos/${repository}/pulls/${pull.number}/comments`),
    ]);

    const landed = pull.merged_at !== null;
    const state = landed
      ? `landed on \`${plan.target}\` ${pull.merged_at?.slice(0, 10)}`
      : pull.state === "open"
        ? "open; this run updates it"
        : "closed without landing; its resolutions were not accepted";
    sections.push("", `## #${pull.number} (${state})`);

    const records = comments.filter(isResolutionRecord);
    if (records.length > 0) {
      sections.push("", "### Agent resolution records", ...records.map((r) => quote(r.body ?? "")));
    }

    const remarks = [
      ...reviews
        .filter(
          (review) =>
            isMaintainerRemark(review) || (byMaintainer(review) && review.state === "APPROVED"),
        )
        .map(
          (review) =>
            `- @${review.user?.login} reviewed (${review.state}):\n${quote(review.body || "(no comment)")}`,
        ),
      ...reviewComments
        .filter(isMaintainerRemark)
        .map(
          (remark) =>
            `- @${remark.user?.login} on \`${remark.path}\`:\n${quote(remark.body ?? "")}`,
        ),
      ...comments
        .filter(isMaintainerRemark)
        .map((remark) => `- @${remark.user?.login}:\n${quote(remark.body ?? "")}`),
    ];
    if (remarks.length > 0) {
      sections.push("", "### Maintainer remarks", ...remarks);
    }

    if (landed || pull.state === "open") {
      const lines: string[] = [];
      for (const commit of resolutionCommits(git, pull, plan.source)) {
        commits.push({ sha: commit.sha, pullRequest: pull.number, isMerge: commit.isMerge });
        lines.push(
          `- \`${short(commit.sha)}\` ${commit.isMerge ? "merge" : `fix by ${commit.author}`}: ${commit.subject}`,
        );
      }
      if (lines.length > 0) {
        sections.push("", "### Resolution commits", ...lines);
      }
    }
  }

  if (pulls.length === 0) {
    sections.push("", "None yet.");
  }
  return { markdown: `${sections.join("\n")}\n`, commits };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validates the agent's structured output; anything else is treated as no resolution. */
export function parseResolution(value: unknown): AgentResolution | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const files = candidate.files;
  const decisions = candidate.decisions;
  const valid =
    (candidate.status === "resolved" || candidate.status === "unresolved") &&
    typeof candidate.summary === "string" &&
    isStringArray(candidate.deletedFiles) &&
    Array.isArray(files) &&
    files.every(
      (file: Record<string, unknown>) =>
        typeof file?.path === "string" &&
        typeof file.resolution === "string" &&
        (file.precedent === null || Number.isSafeInteger(file.precedent)),
    ) &&
    Array.isArray(decisions) &&
    decisions.every(
      (decision: Record<string, unknown>) =>
        isStringArray(decision?.paths) &&
        typeof decision.question === "string" &&
        typeof decision.chosen === "string" &&
        typeof decision.alternative === "string",
    );
  return valid ? (candidate as unknown as AgentResolution) : undefined;
}

const MAX_TURNS_PER_CALL = 150;
const MAX_USD_PER_CALL = 12;
const MAX_USD_PER_RUN = 80;
const MIN_CALL_USD = 1;
const MAX_MINUTES_PER_CALL = 25;
/** Below the workflow job's timeout, so a slow run still hands the merge to a person instead of being killed. */
const RUN_DEADLINE_MINUTES = 70;
/** A call with less time left than this would only be cut off. */
const MIN_CALL_MINUTES = 5;

/** A read-only explorer on a cheaper model, so broad searches do not spend the resolving model's tokens. */
const EXPLORER_AGENT = {
  explorer: {
    description:
      "Read-only repository search: finds files, symbols, callers, usages, and where code moved, and reports file:line answers. Use it for any search beyond the files you are resolving.",
    prompt:
      "Search the repository read-only and answer with concise file:line findings. Do not resolve conflicts, judge behavior, or edit files.",
    tools: ["Read", "Grep", "Glob"],
    model: "haiku",
  },
};

export interface AgentOptions {
  workDir: string;
  contextDir: string;
  cliDir: string;
  image: string;
  model: string;
  prompt: string;
  schema: string;
  /** Continues this session, from the same home directory, instead of starting over. */
  resume?: { sessionId: string; home: string };
  timeoutMinutes: number;
  maxBudgetUsd: number;
}

export interface AgentRun {
  outcome: AgentResolution | string;
  /** The reported cost, or the call's whole budget when the call ended without reporting one. */
  costUsd: number;
  session: { sessionId: string; home: string };
}

/**
 * Runs Claude Code in a container that sees only the worktree (with `.git` read-only), the context
 * directory, and the API key, so a prompt-injected agent cannot reach the runner or other credentials.
 */
export function runClaudeAgent(options: AgentOptions): AgentRun {
  const session = options.resume ?? {
    sessionId: randomUUID(),
    home: mkdtempSync(join(tmpdir(), "sync-agent-home-")),
  };
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      user,
      "--env",
      "ANTHROPIC_API_KEY",
      "--env",
      "HOME=/home/agent",
      "--volume",
      `${options.workDir}:/work`,
      "--volume",
      `${join(options.workDir, ".git")}:/work/.git:ro`,
      "--volume",
      `${options.contextDir}:/context:ro`,
      "--volume",
      `${options.cliDir}:/opt/claude:ro`,
      "--volume",
      `${session.home}:/home/agent`,
      "--workdir",
      "/work",
      options.image,
      "/opt/claude/bin/claude",
      "--bare",
      "--strict-mcp-config",
      ...(options.resume ? ["--resume", session.sessionId] : ["--session-id", session.sessionId]),
      "-p",
      options.prompt,
      "--model",
      options.model,
      "--agents",
      JSON.stringify(EXPLORER_AGENT),
      "--output-format",
      "json",
      "--json-schema",
      options.schema,
      "--allowedTools",
      "Read,Grep,Glob,Edit,Write,Agent(explorer),Task(explorer)",
      "--disallowedTools",
      "Bash,BashOutput,KillShell,WebFetch,WebSearch,NotebookEdit,Agent(general-purpose),Task(general-purpose),Agent(Plan),Task(Plan)",
      "--add-dir",
      "/context",
      "--max-turns",
      String(MAX_TURNS_PER_CALL),
      "--max-budget-usd",
      options.maxBudgetUsd.toFixed(2),
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
      timeout: options.timeoutMinutes * 60 * 1000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY"),
      },
    },
  );
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      outcome: timedOut
        ? `Claude timed out after ${options.timeoutMinutes} minutes.`
        : `Claude did not run: ${result.error.message}`,
      costUsd: timedOut ? options.maxBudgetUsd : 0,
      session,
    };
  }
  let output: {
    is_error?: boolean;
    subtype?: string;
    session_id?: string;
    structured_output?: unknown;
    num_turns?: number;
    total_cost_usd?: number;
  };
  try {
    output = JSON.parse(result.stdout);
  } catch {
    return {
      outcome: `Claude exited with status ${result.status} without a result.`,
      costUsd: options.maxBudgetUsd,
      session,
    };
  }
  const costUsd = output.total_cost_usd ?? 0;
  console.log(
    `Claude ${output.subtype ?? "finished"} after ${output.num_turns} turns for $${costUsd.toFixed(2)}.`,
  );
  const outcome =
    output.is_error || result.status !== 0
      ? `Claude stopped (${output.subtype ?? `exit ${result.status}`}) after ${output.num_turns} turns.`
      : (parseResolution(output.structured_output) ?? "Claude returned no valid resolution.");
  return { outcome, costUsd, session };
}

export function conflictPrompt(
  basePrompt: string,
  plan: ResolutionPlan,
  conflict: Conflict,
): string {
  const others = conflict.allFiles.filter((file) => !conflict.files.includes(file));
  return [
    basePrompt,
    "## This merge",
    "",
    `HEAD is ${plan.pullRequest === null ? `the \`${plan.target}\` tip` : `the open sync pull request #${plan.pullRequest}, which already contains \`${plan.target}\``}. The incoming side is \`${conflict.ref}\` at \`${conflict.sha}\`.`,
    "",
    `Resolve group ${conflict.group} of ${conflict.groups}:`,
    "",
    ...conflict.files.map((file) => `- \`${file}\``),
    ...(others.length > 0
      ? [
          "",
          "Separate calls resolve the other conflicted files; leave their conflict markers alone, and expect a file earlier in this list to be resolved already:",
          "",
          ...others.map((file) => `- \`${file}\``),
        ]
      : []),
    ...(conflict.previousFailure
      ? [
          "",
          `A previous attempt on this group was rejected: ${conflict.previousFailure} Some files may already be edited; check each one from its current state.`,
        ]
      : []),
    "",
  ].join("\n");
}

function continuePrompt(conflict: Conflict): string {
  return [
    `Your attempt on group ${conflict.group} was rejected or stopped: ${conflict.previousFailure}`,
    "Continue from the current state of the files: finish resolving every file in this group, then return the complete JSON result for the whole group.",
  ].join("\n\n");
}

/**
 * Claude for every agent call of one run: resolves each conflict group, resuming its session on a retry, and fixes
 * type errors. Calls stop once the run budget or deadline is spent.
 */
function claudeAgent(
  git: GitRunner,
  contextDir: string,
  precedentCommits: PrecedentCommit[],
  agentOptions: (
    prompt: string,
  ) => Omit<AgentOptions, "resume" | "timeoutMinutes" | "maxBudgetUsd">,
  prompts: { resolve: (conflict: Conflict) => string; fix: string },
): { resolveGroup: ConflictResolver; fixTypeErrors: TypeErrorFixer } {
  const sessions = new Map<string, { sessionId: string; home: string }>();
  const deadline = Date.now() + RUN_DEADLINE_MINUTES * 60 * 1000;
  let spentUsd = 0;

  const call = (
    prompt: string,
    resume?: { sessionId: string; home: string },
  ): AgentRun | string => {
    const budgetLeftUsd = MAX_USD_PER_RUN - spentUsd;
    if (budgetLeftUsd < MIN_CALL_USD) {
      return `The run already spent $${spentUsd.toFixed(2)} of its $${MAX_USD_PER_RUN} budget.`;
    }
    const minutesLeft = Math.floor((deadline - Date.now()) / 60_000);
    if (minutesLeft < MIN_CALL_MINUTES) {
      return `The run reached its ${RUN_DEADLINE_MINUTES}-minute deadline.`;
    }
    const run = runClaudeAgent({
      ...agentOptions(prompt),
      ...(resume ? { resume } : {}),
      timeoutMinutes: Math.min(MAX_MINUTES_PER_CALL, minutesLeft),
      maxBudgetUsd: Math.min(MAX_USD_PER_CALL, budgetLeftUsd),
    });
    spentUsd += run.costUsd;
    return run;
  };

  return {
    async resolveGroup(conflict) {
      const key = `${conflict.sha}:${conflict.group}`;
      const previous = conflict.previousFailure ? sessions.get(key) : undefined;
      writeConflictContext(git, join(contextDir, "conflicts.md"), conflict, precedentCommits);
      console.log(
        `Claude: ${conflict.ref} group ${conflict.group}/${conflict.groups} (${conflict.files.length} files)${previous ? ", resuming" : conflict.previousFailure ? ", retrying" : ""}…`,
      );
      const run = call(previous ? continuePrompt(conflict) : prompts.resolve(conflict), previous);
      if (typeof run === "string") {
        return run;
      }
      sessions.set(key, run.session);
      return run.outcome;
    },
    async fixTypeErrors(output) {
      writeFileSync(join(contextDir, "type-errors.txt"), output);
      console.log("Claude: fixing type errors…");
      const run = call(prompts.fix);
      return typeof run === "string" ? run : run.outcome;
    },
  };
}

async function main(): Promise<void> {
  const plan = JSON.parse(requireEnv("PLAN")) as ResolutionPlan;
  const workDir = resolve(requireEnv("WORK_DIR"));
  const outputDir = resolve(requireEnv("OUTPUT_DIR"));
  const contextDir = mkdtempSync(join(tmpdir(), "sync-context-"));
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("REPOSITORY");
  const basePrompt = readFileSync(".github/sync-branches/resolve-prompt.md", "utf8");
  const fixPrompt = readFileSync(".github/sync-branches/fix-prompt.md", "utf8");
  const { $schema: _, ...schema } = JSON.parse(
    readFileSync(".github/sync-branches/resolution.schema.json", "utf8"),
  ) as Record<string, unknown>;
  mkdirSync(outputDir, { recursive: true });

  const git = makeGit(workDir);
  const precedents = await gatherPrecedents(
    (path) => githubRequest(token, path),
    git,
    repository,
    plan,
  );
  writeFileSync(join(contextDir, "precedents.md"), precedents.markdown);

  const agent = claudeAgent(
    git,
    contextDir,
    precedents.commits,
    (prompt) => ({
      workDir,
      contextDir,
      cliDir: requireEnv("CLAUDE_CLI_DIR"),
      image: requireEnv("AGENT_IMAGE"),
      model: requireEnv("CLAUDE_MODEL"),
      prompt,
      schema: JSON.stringify(schema),
    }),
    { resolve: (conflict) => conflictPrompt(basePrompt, plan, conflict), fix: fixPrompt },
  );
  const replayed = await replayMerges(git, workDir, plan, agent.resolveGroup);
  const result =
    replayed.status === "resolved"
      ? await withTypeCheck(
          git,
          replayed,
          () => runChecks(workDir, requireEnv("AGENT_IMAGE")),
          agent.fixTypeErrors,
        )
      : replayed;

  if (result.status === "resolved") {
    gitOrThrow(git, ["update-ref", "refs/sync/resolved", result.head]);
    gitOrThrow(git, [
      "bundle",
      "create",
      join(outputDir, "resolved.bundle"),
      "refs/sync/resolved",
      `^${plan.base}`,
    ]);
  }
  writeFileSync(join(outputDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(
    result.status === "resolved"
      ? `Resolved ${result.merges.length} merge(s); head ${result.head}.`
      : `::warning::Needs a maintainer: ${result.reason}`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
