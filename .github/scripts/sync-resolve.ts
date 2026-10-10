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
  type AgentCaller,
  type AgentResolution,
  type AgentSession,
  createAgentCaller,
  loadSchema,
  parseResolution,
} from "./sync-agent.ts";
import {
  PROTECTED_PATH_PREFIX,
  type ResolutionPlan,
  agentWrittenText,
  protectedPathChanges,
  syncBranchName,
} from "./sync-branches.ts";
import { redactSecrets, redactSecretsDeep } from "./ai-review/post-review.ts";
import { type CheckFixer, type CheckResult, checkAndFix, runChecks } from "./sync-checks.ts";

export interface MergeRecord {
  ref: string;
  sha: string;
  /** Null when the merge was clean. */
  resolution: AgentResolution | null;
}

export type { AgentResolution, CheckResult };

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

/** Prefixes the bot comment that starts a repair round, `<!-- sync-repair round=N head=SHA -->`; one per round. */
export const REPAIR_MARKER = "<!-- sync-repair round=";

/** Prefixes the bot comment that records what a repair round did; later runs read these as precedent. */
export const REPAIR_RESULT_MARKER = "<!-- sync-repair-result";

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
    // A later group's edits can touch an earlier group's files, so every conflicted file is checked again.
    const leftover = allFiles.find((path) => {
      const file = join(workDir, path);
      return (
        !combined.deletedFiles.includes(path) &&
        existsSync(file) &&
        CONFLICT_MARKER.test(readFileSync(file, "utf8"))
      );
    });
    if (leftover !== undefined) {
      return giveUp(
        `\`${leftover}\` still contains conflict markers after every group was resolved.`,
      );
    }
    for (const path of combined.deletedFiles) {
      gitOrThrow(git, ["rm", "-q", "--ignore-unmatch", "--", path]);
    }
    gitOrThrow(git, ["add", "-A"]);
    gitOrThrow(git, ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-m", message]);
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

function byMaintainer(remark: Remark, writers: Set<string>): boolean {
  return remark.user?.type !== "Bot" && writers.has(remark.user?.login ?? "");
}

function isMaintainerRemark(remark: Remark, writers: Set<string>): boolean {
  return byMaintainer(remark, writers) && Boolean(remark.body?.trim());
}

const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/**
 * The remark authors with write access to the repository. Association alone is not enough: an organization member
 * or collaborator may only have read access, and these remarks steer an agent whose edits run in CI.
 */
async function writersAmong(
  get: GithubGet,
  repository: string,
  remarks: Remark[],
  known: Map<string, boolean>,
): Promise<Set<string>> {
  for (const remark of remarks) {
    const login = remark.user?.login;
    if (!login || known.has(login) || !TRUSTED_ASSOCIATIONS.has(remark.author_association)) {
      continue;
    }
    const permission = (await get(`/repos/${repository}/collaborators/${login}/permission`).catch(
      () => undefined,
    )) as { permission?: string } | undefined;
    known.set(login, WRITE_PERMISSIONS.has(permission?.permission ?? ""));
  }
  return new Set([...known].filter(([, canWrite]) => canWrite).map(([login]) => login));
}

function isResolutionRecord(remark: Remark): boolean {
  return (
    remark.user?.login === RELEASE_BOT_LOGIN &&
    Boolean(
      remark.body?.startsWith(RESOLUTION_MARKER) || remark.body?.startsWith(REPAIR_RESULT_MARKER),
    )
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
 * that landed. Remarks from anyone without write permission on the repository are left out.
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

  const permissions = new Map<string, boolean>();
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

    const writers = await writersAmong(
      get,
      repository,
      [...comments, ...reviews, ...reviewComments],
      permissions,
    );
    const remarks = [
      ...reviews
        .filter(
          (review) =>
            isMaintainerRemark(review, writers) ||
            (byMaintainer(review, writers) && review.state === "APPROVED"),
        )
        .map(
          (review) =>
            `- @${review.user?.login} reviewed (${review.state}):\n${quote(review.body || "(no comment)")}`,
        ),
      ...reviewComments
        .filter((remark) => isMaintainerRemark(remark, writers))
        .map(
          (remark) =>
            `- @${remark.user?.login} on \`${remark.path}\`:\n${quote(remark.body ?? "")}`,
        ),
      ...comments
        .filter((remark) => isMaintainerRemark(remark, writers))
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

/** Resolves each conflict group with Claude, resuming the group's session on a retry. */
function groupResolver(
  call: AgentCaller,
  git: GitRunner,
  contextDir: string,
  precedentCommits: PrecedentCommit[],
  schema: string,
  prompt: (conflict: Conflict) => string,
): ConflictResolver {
  const sessions = new Map<string, AgentSession>();
  return async (conflict) => {
    const key = `${conflict.sha}:${conflict.group}`;
    const previous = conflict.previousFailure ? sessions.get(key) : undefined;
    writeConflictContext(git, join(contextDir, "conflicts.md"), conflict, precedentCommits);
    console.log(
      `Claude: ${conflict.ref} group ${conflict.group}/${conflict.groups} (${conflict.files.length} files)${previous ? ", resuming" : conflict.previousFailure ? ", retrying" : ""}…`,
    );
    const run = call(
      previous ? continuePrompt(conflict) : prompt(conflict),
      schema,
      parseResolution,
      previous,
    );
    if (typeof run === "string") {
      return run;
    }
    sessions.set(key, run.session);
    return run.outcome;
  };
}

/** Asks Claude to fix the failing checks, with their output in `check-failures.txt`. */
export function checkFixer(
  call: AgentCaller,
  contextDir: string,
  schema: string,
  prompt: string,
): CheckFixer {
  return async (output) => {
    writeFileSync(join(contextDir, "check-failures.txt"), output);
    console.log("Claude: fixing the failing checks…");
    const run = call(prompt, schema, parseResolution);
    return typeof run === "string" ? run : run.outcome;
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
  const schema = loadSchema(readFileSync(".github/sync-branches/resolution.schema.json", "utf8"));
  mkdirSync(outputDir, { recursive: true });

  const git = makeGit(workDir);
  const precedents = await gatherPrecedents(
    (path) => githubRequest(token, path),
    git,
    repository,
    plan,
  );
  writeFileSync(join(contextDir, "precedents.md"), precedents.markdown);

  const call = createAgentCaller({
    workDir,
    contextDir,
    cliDir: requireEnv("CLAUDE_CLI_DIR"),
    image: requireEnv("AGENT_IMAGE"),
    model: requireEnv("CLAUDE_MODEL"),
  });
  const replayed = await replayMerges(
    git,
    workDir,
    plan,
    groupResolver(call, git, contextDir, precedents.commits, schema, (conflict) =>
      conflictPrompt(basePrompt, plan, conflict),
    ),
  );
  let result: ResolveResult = replayed;
  if (replayed.status === "resolved") {
    const check = await checkAndFix(
      git,
      () => runChecks(workDir, requireEnv("CHECK_IMAGE")),
      checkFixer(call, contextDir, schema, fixPrompt),
      `chore(repo): fix checks after merging ${plan.source} into ${syncBranchName(plan)}`,
    );
    result = { ...replayed, head: gitOrThrow(git, ["rev-parse", "HEAD"]), check };
    // The agent's container holds the API key; nothing secret-shaped it wrote may reach the artifact or the branch.
    const written = agentWrittenText(git, plan.base, result.head);
    if (redactSecrets(written) !== written) {
      const merge = plan.merges.at(-1);
      result = {
        status: "manual",
        reason: "The agent's changes contain secret-shaped text, so they were discarded.",
        ref: merge?.ref ?? plan.source,
        sha: merge?.sha ?? "",
        files: replayed.merges.flatMap(
          ({ resolution }) => resolution?.files.map(({ path }) => path) ?? [],
        ),
      };
    }
  }

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
  writeFileSync(join(outputDir, "result.json"), JSON.stringify(redactSecretsDeep(result), null, 2));
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
