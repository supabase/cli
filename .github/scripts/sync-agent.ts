/**
 * Lets Claude finish a conflicting `develop` → `next` sync and repair its pull request after CI and the AI review.
 * See apps/cli/docs/release-process.md#claude-resolved-develop-into-next.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AI_REVIEW_MARKER,
  type AiReviewState,
  isSuperseded,
  parseAiReviewState,
} from "./ai-review/post-review.ts";
import {
  type CheckRun,
  fetchPullRequestCheckRuns,
  hasChangesRequested,
  type PullRequestReview,
  REQUIRED_CHECKS,
} from "./fast-forward.ts";
import {
  githubGraphql,
  githubRequest,
  gitOrThrow,
  type GitRunner,
  makeGit,
  RELEASE_BOT_LOGIN,
  requireEnv,
} from "./promotion-shared.ts";

const SYNC_BRANCH = "sync/develop-into-next";
const PROMPTS_DIR = join(import.meta.dir, "../sync-branches");
const RESOLVE_MARKER = "<!-- sync-agent resolve -->";
const REPAIR_MARKER = "<!-- sync-agent repair";
const EXHAUSTED_MARKER = "<!-- sync-agent exhausted -->";
/** Workflows on the sync branch run with repository secrets, so Claude's edits there are only proposed. */
const WORKFLOWS = ".github/";
/** Every merge in a pushed resolution brings in reviewed `next` commits, never a commit made during the run. */
const MERGED_BRANCH = "refs/remotes/origin/next";
const WORKFLOW_DIFF = "github.diff";
const MAX_REPAIR_ROUNDS = 2;
const LOG_TAIL_LINES = 150;
/** The quick checks of the pull request's CI; integration and end-to-end tests are left to CI and `Sync repair`. */
const CHECKS = [
  ["pnpm", "run", "check:all", "--continue"],
  ["pnpm", "run", "test:unit"],
];

/** Author of the AI review's inline comments; GraphQL drops the `[bot]` suffix from bot logins. */
const AI_REVIEW_LOGIN = "github-actions[bot]";

export interface ReviewThread {
  threadId: string;
  commentId: number;
  path: string;
  line: number | null;
  body: string;
}

export type RepairPlan =
  | { action: "skip"; reason: string }
  | { action: "exhausted" }
  | { action: "approve" }
  | { action: "repair"; failures: CheckRun[]; threads: ReviewThread[] };

function repairMarker(head: string): string {
  return `${REPAIR_MARKER} head=${head} -->`;
}

function workflowMarker(head: string): string {
  return `<!-- sync-agent workflow-suggestions head=${head} -->`;
}

/** Branch policy fails `Require fast-forward` on every sync pull request by design; the others run on approval. */
function isIgnoredCheck(name: string): boolean {
  return (
    name === "Require fast-forward" || name === "Check approver" || name.startsWith("Fast-forward ")
  );
}

function isLogin(login: string | undefined, bot: string): boolean {
  return login === bot || `${login}[bot]` === bot;
}

function latestRuns(runs: CheckRun[]): CheckRun[] {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const current = latest.get(run.name);
    if (!current || run.id > current.id) {
      latest.set(run.name, run);
    }
  }
  return [...latest.values()];
}

/**
 * Repairs once the head's checks settle, at most `MAX_REPAIR_ROUNDS` times per pull request. A head a round already
 * repaired gets another round only for new review findings; its remaining failures go to a maintainer. Markers count
 * only at the start of a bot comment, where Claude's text never goes.
 */
export function planRepair(state: {
  head: string;
  botComments: string[];
  runs: CheckRun[];
  threads: ReviewThread[];
  reviewRunning: boolean;
  /** The latest AI review, with how many of its inline threads are resolved or answered by the release bot. */
  aiReview: (AiReviewState & { answeredThreads: number }) | null;
  /** Whether any reviewer's latest verdict is "Request changes". */
  changesRequested: boolean;
}): RepairPlan {
  const { head, botComments, threads } = state;
  if (!botComments.some((body) => body.startsWith(RESOLVE_MARKER))) {
    return { action: "skip", reason: "Claude did not resolve this pull request." };
  }
  if (botComments.some((body) => body.startsWith(EXHAUSTED_MARKER))) {
    return { action: "skip", reason: "Already handed to a maintainer." };
  }
  const runs = latestRuns(state.runs.filter((run) => !isIgnoredCheck(run.name)));
  if (
    REQUIRED_CHECKS.some((name) => !runs.some((run) => run.name === name)) ||
    runs.some((run) => run.status !== "completed")
  ) {
    return { action: "skip", reason: "Checks are still running." };
  }
  if (state.reviewRunning) {
    return { action: "skip", reason: "The AI review is still running." };
  }
  if (botComments.some((body) => body.startsWith(workflowMarker(head)))) {
    return {
      action: "skip",
      reason: "Waiting for a maintainer to commit the workflow suggestions.",
    };
  }
  const failures = runs.filter(
    (run) => !["success", "neutral", "skipped"].includes(run.conclusion ?? ""),
  );
  if (threads.length === 0 && failures.length === 0) {
    return planApproval(head, state.aiReview, state.changesRequested);
  }
  const rounds = botComments.filter((body) => body.startsWith(REPAIR_MARKER)).length;
  const headRepaired = botComments.some((body) => body.startsWith(repairMarker(head)));
  if (rounds >= MAX_REPAIR_ROUNDS || (headRepaired && threads.length === 0)) {
    return { action: "exhausted" };
  }
  return { action: "repair", failures, threads };
}

/**
 * Approves only a head both models reviewed, where every finding they did not refute has a thread Claude fixed or
 * declined. Findings only in the review body have no thread, so they wait for a maintainer.
 */
function planApproval(
  head: string,
  review: (AiReviewState & { answeredThreads: number }) | null,
  changesRequested: boolean,
): RepairPlan {
  if (changesRequested) {
    return { action: "skip", reason: "A reviewer requested changes." };
  }
  if (review?.head !== head) {
    return { action: "skip", reason: "Nothing to repair; the AI review did not see this head." };
  }
  if (!review.complete) {
    return { action: "skip", reason: "Only one model finished the AI review." };
  }
  if (review.answeredThreads < review.findings) {
    return {
      action: "skip",
      reason: "AI review findings without an answered thread need a maintainer.",
    };
  }
  return { action: "approve" };
}

/** Lines that still carry a conflict marker, as `path:line`. */
export function leftoverConflictMarkers(workDir: string, paths: string[]): string[] {
  return paths.flatMap((path) => {
    const file = join(workDir, path);
    if (!existsSync(file)) {
      return [];
    }
    return readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        /^(<{7}|\|{7}|>{7})( |$)|^={7}$/.test(line) ? [`${path}:${index + 1}`] : [],
      );
  });
}

/**
 * Runs Claude Code with file tools only: edits stay in the worktree outside `.git`, and with no shell, network tools,
 * or `/proc` reads the API key in its environment stays out of reach. `--bare` is avoided because it also drops the
 * search and write tools; ignoring project settings keeps the merged tree's hooks from running.
 */
function runClaude(prompt: string, schemaFile: string, workDir: string, contextDir?: string) {
  const { $schema: _, ...schema } = JSON.parse(readFileSync(join(PROMPTS_DIR, schemaFile), "utf8"));
  const result = spawnSync(
    "claude",
    [
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "-p",
      prompt,
      "--model",
      requireEnv("CLAUDE_MODEL"),
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify(schema),
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Grep,Glob",
      "--disallowedTools",
      "Bash,WebFetch,WebSearch,Read(//proc/**),Grep(//proc/**),Glob(//proc/**),Edit(./.git/**),Write(./.git/**)",
      ...(contextDir ? ["--add-dir", contextDir] : []),
      "--max-turns",
      "200",
      "--max-budget-usd",
      "40",
    ],
    {
      cwd: workDir,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 60 * 60 * 1000,
    },
  );
  try {
    const events = (result.stdout ?? "")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const init = events.find((event) => event.type === "system" && event.subtype === "init");
    console.log(`Claude tools: ${JSON.stringify(init?.tools)}`);
    const output = events.findLast((event) => event.type === "result") as {
      is_error?: boolean;
      subtype?: string;
      num_turns?: number;
      total_cost_usd?: number;
      structured_output?: unknown;
      permission_denials?: { tool_name: string }[];
    };
    console.log(
      `Claude ${output.subtype} after ${output.num_turns} turns for $${output.total_cost_usd?.toFixed(2)}; denied: ${JSON.stringify(output.permission_denials?.map((denial) => denial.tool_name) ?? [])}.`,
    );
    if (output.is_error || result.status !== 0 || output.structured_output === undefined) {
      return `Claude stopped (${output.subtype ?? `exit ${result.status}`}).`;
    }
    return output.structured_output;
  } catch {
    return `Claude exited with status ${result.status ?? result.error?.message} without a result.`;
  }
}

function commit(git: GitRunner, message?: string): void {
  gitOrThrow(git, ["add", "-A"]);
  gitOrThrow(git, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--no-verify",
    ...(message ? ["-m", message] : ["--no-edit"]),
  ]);
}

/**
 * Commits the working tree except `.github/`, which is reset to `baseline` (with `ours` paths from `HEAD`). The edits
 * left out are saved as a diff that publish turns into review suggestions. Returns whether a commit was made.
 */
function commitOutsideWorkflows(
  git: GitRunner,
  outputDir: string,
  message: string | undefined,
  baseline = "HEAD",
  ours: string[] = [],
): boolean {
  gitOrThrow(git, ["add", "-A"]);
  const proposed = gitOrThrow(git, ["write-tree"]);
  gitOrThrow(git, ["restore", `--source=${baseline}`, "--staged", "--worktree", "--", WORKFLOWS]);
  for (const path of ours) {
    gitOrThrow(
      git,
      git(["cat-file", "-e", `HEAD:${path}`]).status === 0
        ? ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", path]
        : ["--literal-pathspecs", "rm", "--quiet", "--force", "--ignore-unmatch", "--", path],
    );
  }
  const merging = git(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]).status === 0;
  const committed = merging || git(["diff", "--cached", "--quiet"]).status !== 0;
  if (committed) {
    commit(git, message);
  }
  gitOrThrow(git, [
    "diff",
    "--unified=0",
    `--output=${join(outputDir, WORKFLOW_DIFF)}`,
    "HEAD",
    proposed,
    "--",
    WORKFLOWS,
  ]);
  return committed;
}

/** Puts the proposed workflow edits back into the working tree, so checks and Claude see the whole resolution. */
function applyWorkflowDiff(git: GitRunner, outputDir: string): void {
  const file = join(outputDir, WORKFLOW_DIFF);
  if (existsSync(file) && readFileSync(file, "utf8") !== "") {
    gitOrThrow(git, ["apply", "--unidiff-zero", file]);
  }
}

function setOutput(name: string, value: string): void {
  appendFileSync(requireEnv("GITHUB_OUTPUT"), `${name}=${value}\n`);
}

function runLink(): string {
  return `[workflow run](${requireEnv("RUN_URL")})`;
}

function outputTail(text: string): string {
  return (
    text
      // oxlint-disable-next-line no-control-regex -- strips ANSI colour codes from tool output
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .slice(-LOG_TAIL_LINES)
      .join("\n")
  );
}

/**
 * Installs the merged tree's toolchain and dependencies, regenerating the lockfile, formats it, and runs its quick
 * checks. Returns one report per failing command.
 */
function runChecks(workDir: string): string[] {
  const env = {
    ...process.env,
    CI: "true",
    HUSKY: "0",
    MISE_TRUSTED_CONFIG_PATHS: workDir,
    MISE_YES: "1",
  };
  const run = (command: string[]) => {
    console.log(`::group::${command.join(" ")}`);
    const [program = "", ...args] =
      command[0] === "mise" ? command : ["mise", "exec", "--", ...command];
    const result = spawnSync(program, args, {
      cwd: workDir,
      env,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    console.log(outputTail(output));
    console.log("::endgroup::");
    return result.status === 0
      ? []
      : [
          `## \`${command.join(" ")}\` (${result.error?.message ?? `exit ${result.status}`})\n\n\`\`\`\`text\n${outputTail(output)}\n\`\`\`\`\n`,
        ];
  };
  const setup = [...run(["mise", "install"]), ...run(["pnpm", "install", "--no-frozen-lockfile"])];
  if (setup.length > 0) {
    return setup;
  }
  run(["pnpm", "run", "fmt:fix"]);
  return CHECKS.flatMap(run);
}

/** Runs the quick checks on the resolution, commits the formatter's and lockfile's changes, and writes the failures. */
function check(workDir: string, outputDir: string): void {
  const git = makeGit(workDir);
  applyWorkflowDiff(git, outputDir);
  const failures = runChecks(workDir);
  commitOutsideWorkflows(git, outputDir, "chore(repo): format the develop-into-next merge");
  setOutput("failed", String(failures.length > 0));
  const contextDir = join(outputDir, "context");
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, "ci-failures.md"), failures.join("\n"));
  writeFileSync(join(contextDir, "review-findings.md"), "No open review findings.\n");
  appendFileSync(
    join(outputDir, "comment.md"),
    failures.length > 0
      ? `**Quick checks.** ${failures.map((failure) => failure.split("\n")[0]?.replace(/^## /, "")).join(", ")} failed on the merged tree.\n\n`
      : "**Quick checks.** The merged tree passes `check:all` and unit tests.\n\n",
  );
}

/**
 * Lets Claude fix the checked-out tree from the context files. Its edits are committed, except under `.github/`, only
 * when it returned a result.
 */
function claudeFix(workDir: string, outputDir: string, message: string) {
  const git = makeGit(workDir);
  applyWorkflowDiff(git, outputDir);
  const output = runClaude(
    readFileSync(join(PROMPTS_DIR, "repair-prompt.md"), "utf8"),
    "repair.schema.json",
    workDir,
    join(outputDir, "context"),
  );
  const result = typeof output === "object" ? (output as Repair) : undefined;
  const changed = result !== undefined && commitOutsideWorkflows(git, outputDir, message);
  setOutput("changed", String(changed));
  return {
    result,
    summary:
      result?.summary ??
      `${typeof output === "string" ? output : ""} @supabase/cli please take a look.`,
  };
}

/** Lets Claude fix the quick checks that failed, once; CI runs them again on the pull request. */
function fix(workDir: string, outputDir: string): void {
  const { summary } = claudeFix(workDir, outputDir, "chore(repo): fix the develop-into-next merge");
  appendFileSync(join(outputDir, "comment.md"), `**Claude's fix.** ${summary}\n\n`);
}

/** `git status` codes for unmerged paths; `HEAD` is `develop` and the merged side is `next`. */
const CONFLICT_KINDS: Record<string, string> = {
  UU: "both modified",
  AA: "both added",
  DU: "deleted on develop, modified on next",
  UD: "modified on develop, deleted on next",
  AU: "added on develop",
  UA: "added on next",
  DD: "deleted on both",
};

function conflictedPaths(git: GitRunner): { path: string; kind: string }[] {
  return gitOrThrow(git, ["status", "--porcelain=v1", "-z", "--untracked-files=no"])
    .split("\0")
    .flatMap((entry) => {
      const kind = CONFLICT_KINDS[entry.slice(0, 2)];
      return kind ? [{ path: entry.slice(3), kind }] : [];
    });
}

interface Resolution {
  status: "resolved" | "unresolved";
  summary: string;
  files: { path: string; resolution: string }[];
  deletedFiles: string[];
  decisions: { question: string; chosen: string }[];
}

/** Merges `next` into the sync branch, which starts at the `develop` tip, and lets Claude resolve the conflicts. */
function resolve(workDir: string, outputDir: string): void {
  const git = makeGit(workDir);
  if (git(["merge-base", "--is-ancestor", "origin/next", "HEAD"]).status === 0) {
    console.log("The sync branch already contains next.");
    setOutput("resolved", "false");
    return;
  }
  const merge = git([
    "-c",
    "merge.conflictStyle=zdiff3",
    "merge",
    "--no-ff",
    "--no-commit",
    "origin/next",
  ]);
  const conflicts = conflictedPaths(git);
  if (merge.status !== 0 && conflicts.length === 0) {
    throw new Error(`git merge failed without conflicts: ${merge.stderr || merge.stdout}`);
  }
  // git's own merge, conflict markers included; conflicted workflows keep the `develop` side until a maintainer acts.
  const autoMerge =
    git(["merge-tree", "--write-tree", "--no-messages", "HEAD", "origin/next"]).stdout.split(
      "\n",
    )[0] ?? "";

  const prompt = [
    readFileSync(join(PROMPTS_DIR, "resolve-prompt.md"), "utf8"),
    "## Conflicted files",
    "",
    ...conflicts.map(({ path, kind }) => `- \`${path}\` (${kind})`),
  ].join("\n");
  const output =
    conflicts.length > 0 ? runClaude(prompt, "resolution.schema.json", workDir) : undefined;
  const result = typeof output === "object" ? (output as Resolution) : undefined;
  const deletions = (result?.deletedFiles ?? []).filter((path) =>
    conflicts.some((conflict) => conflict.path === path),
  );
  for (const path of deletions) {
    gitOrThrow(git, ["--literal-pathspecs", "rm", "--quiet", "--ignore-unmatch", "--", path]);
  }
  const leftovers = leftoverConflictMarkers(
    workDir,
    conflicts.map(({ path }) => path),
  );
  const failure =
    typeof output === "string"
      ? output
      : result?.status === "unresolved"
        ? result.summary
        : leftovers.length > 0
          ? `Conflict markers remain at ${leftovers.slice(0, 10).join(", ")}.`
          : undefined;

  if (failure !== undefined) {
    setOutput("resolved", "false");
    writeFileSync(
      join(outputDir, "comment.md"),
      `@supabase/cli Claude could not resolve this merge: ${failure}\n\nResolve it by hand as described above (${runLink()}).\n`,
    );
    return;
  }

  commitOutsideWorkflows(
    git,
    outputDir,
    undefined,
    autoMerge,
    conflicts.map(({ path }) => path).filter((path) => path.startsWith(WORKFLOWS)),
  );
  setOutput("resolved", "true");
  const lines = [
    RESOLVE_MARKER,
    "### Claude resolved the merge of `next`",
    "",
    result?.summary ?? "`next` merged cleanly.",
    "",
    ...(result?.files.length
      ? [
          "| File | Resolution |",
          "| --- | --- |",
          ...result.files.map(
            (file) =>
              `| \`${file.path}\` | ${file.resolution.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
          ),
          "",
        ]
      : []),
    ...(deletions.length > 0
      ? [`Deleted: ${deletions.map((path) => `\`${path}\``).join(", ")}.`, ""]
      : []),
    ...(result?.decisions.length
      ? [
          "**Decisions for @supabase/cli.** Confirm them, or push a change to this branch:",
          "",
          ...result.decisions.map((decision) => `- ${decision.question} Chose: ${decision.chosen}`),
          "",
        ]
      : []),
  ];
  writeFileSync(join(outputDir, "comment.md"), `${lines.join("\n")}\n`);
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 50) {
            nodes { databaseId body path line author { login } pullRequestReview { databaseId body } }
          }
        }
      }
    }
  }
}`;

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: {
          id: string;
          isResolved: boolean;
          comments: {
            nodes: {
              databaseId: number;
              body: string;
              path: string;
              line: number | null;
              author: { login: string } | null;
              pullRequestReview: { databaseId: number; body: string } | null;
            }[];
          };
        }[];
      };
    } | null;
  } | null;
}

/**
 * AI review threads, answered when resolved or replied to by the release bot. Only the AI review's own comments are
 * read, so nobody else's text reaches the agent.
 */
async function fetchAiReviewThreads(
  token: string,
  repository: string,
  number: number,
): Promise<{ thread: ReviewThread; reviewId: number; answered: boolean }[]> {
  const [owner, name] = repository.split("/");
  const page = await githubGraphql<ThreadsPage>(token, THREADS_QUERY, { owner, name, number });
  return (page.repository?.pullRequest?.reviewThreads.nodes ?? []).flatMap((thread) => {
    const [first, ...rest] = thread.comments.nodes;
    if (
      !first?.pullRequestReview?.body.includes(AI_REVIEW_MARKER) ||
      !isLogin(first.author?.login, AI_REVIEW_LOGIN)
    ) {
      return [];
    }
    return [
      {
        thread: {
          threadId: thread.id,
          commentId: first.databaseId,
          path: first.path,
          line: first.line,
          body: first.body,
        },
        reviewId: first.pullRequestReview.databaseId,
        answered:
          thread.isResolved ||
          rest.some((comment) => isLogin(comment.author?.login, RELEASE_BOT_LOGIN)),
      },
    ];
  });
}

async function jobFailureExcerpt(
  token: string,
  repository: string,
  jobId: number,
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    },
  );
  if (!response.ok) {
    return `(log unavailable: ${response.status})`;
  }
  return failureExcerpt(await response.text());
}

const ERROR_CONTEXT_LINES = 40;
const MAX_ERROR_WINDOWS = 10;

/**
 * Keeps the lines after each error annotation plus the log tail, because Turbo interleaves packages and the failing
 * one's output often ends long before the job does.
 */
export function failureExcerpt(log: string): string {
  const lines = log
    // oxlint-disable-next-line no-control-regex -- strips ANSI colour codes from job logs
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.replace(/^\S+Z /, ""));
  const kept = new Set<number>();
  let windows = 0;
  lines.forEach((line, index) => {
    // Turbo prefixes each line with its task name when it streams several packages.
    if (windows < MAX_ERROR_WINDOWS && /^(\S+:\s)?\s*(##\[error\]|FAIL\s)/.test(line)) {
      windows += 1;
      for (let at = index; at < Math.min(index + ERROR_CONTEXT_LINES, lines.length); at += 1) {
        kept.add(at);
      }
    }
  });
  for (let at = Math.max(0, lines.length - LOG_TAIL_LINES); at < lines.length; at += 1) {
    kept.add(at);
  }
  let previous = -1;
  const excerpt: string[] = [];
  for (const index of [...kept].sort((a, b) => a - b)) {
    if (index !== previous + 1) {
      excerpt.push("[...]");
    }
    excerpt.push(lines[index] ?? "");
    previous = index;
  }
  return excerpt.join("\n");
}

/** Whether an `AI Review` run for this pull request is queued or running; its run name carries the PR number. */
async function isReviewRunning(
  token: string,
  repository: string,
  number: number,
): Promise<boolean> {
  for (const status of ["queued", "in_progress"]) {
    const { workflow_runs: runs } = await githubRequest<{
      workflow_runs: { display_title: string }[];
    }>(
      token,
      `/repos/${repository}/actions/workflows/ai-review.yml/runs?status=${status}&per_page=100`,
    );
    if (runs.some((run) => run.display_title === `AI Review #${number}`)) {
      return true;
    }
  }
  return false;
}

async function listAll<T>(token: string, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest<T[]>(token, `${path}?per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) {
      return items;
    }
  }
}

/** Reads the sync pull request's state with the job's read-only token and writes the repair context. */
async function collect(outputDir: string): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const [owner] = repository.split("/");
  const pulls = await githubRequest<{ number: number; draft: boolean; head: { sha: string } }[]>(
    token,
    `/repos/${repository}/pulls?state=open&base=next&head=${owner}:${SYNC_BRANCH}`,
  );
  const pull = pulls[0];
  if (!pull || pull.draft) {
    console.log("No open sync pull request to repair.");
    setOutput("action", "skip");
    return;
  }
  const comments = [
    ...(await listAll<{ user: { login: string } | null; body: string }>(
      token,
      `/repos/${repository}/issues/${pull.number}/comments`,
    )),
  ];
  const reviews = await listAll<PullRequestReview & { id: number; body: string }>(
    token,
    `/repos/${repository}/pulls/${pull.number}/reviews`,
  );
  comments.push(...reviews);
  const aiReview = reviews.findLast(
    (review) =>
      isLogin(review.user?.login, AI_REVIEW_LOGIN) &&
      review.body.includes(AI_REVIEW_MARKER) &&
      !isSuperseded(review.body),
  );
  const aiReviewState = aiReview ? parseAiReviewState(aiReview.body) : null;
  const aiThreads = await fetchAiReviewThreads(token, repository, pull.number);
  const plan = planRepair({
    head: pull.head.sha,
    botComments: comments
      .filter((comment) => comment.user?.login === RELEASE_BOT_LOGIN)
      .map((comment) => comment.body),
    runs: await fetchPullRequestCheckRuns(
      (query, variables) => githubGraphql(token, query, variables),
      repository,
      pull.number,
      pull.head.sha,
    ),
    threads: aiThreads.filter((entry) => !entry.answered).map((entry) => entry.thread),
    reviewRunning: await isReviewRunning(token, repository, pull.number),
    aiReview:
      aiReview && aiReviewState
        ? {
            ...aiReviewState,
            answeredThreads: aiThreads.filter(
              (entry) => entry.reviewId === aiReview.id && entry.answered,
            ).length,
          }
        : null,
    changesRequested: hasChangesRequested(reviews),
  });
  setOutput("action", plan.action);
  setOutput("pr", String(pull.number));
  setOutput("head", pull.head.sha);

  if (plan.action === "skip" || plan.action === "approve") {
    console.log(plan.action === "skip" ? plan.reason : "Ready for approval.");
    return;
  }
  if (plan.action === "exhausted") {
    writeFileSync(
      join(outputDir, "comment.md"),
      `${EXHAUSTED_MARKER}\n@supabase/cli Claude's repair rounds did not get this pull request green; please take over (${runLink()}).\n`,
    );
    return;
  }

  const contextDir = join(outputDir, "context");
  mkdirSync(contextDir, { recursive: true });
  const failures = await Promise.all(
    plan.failures.map(
      async (run) =>
        `## ${run.name} (${run.conclusion})\n\n\`\`\`\`text\n${await jobFailureExcerpt(token, repository, run.id)}\n\`\`\`\`\n`,
    ),
  );
  writeFileSync(join(contextDir, "ci-failures.md"), failures.join("\n") || "No CI job failed.\n");
  writeFileSync(
    join(contextDir, "review-findings.md"),
    plan.threads
      .map(
        (thread, index) =>
          `## Finding ${index + 1}: \`${thread.path}${thread.line ? `:${thread.line}` : ""}\`\n\n${thread.body}\n`,
      )
      .join("\n") || "No open review findings.\n",
  );
  writeFileSync(join(outputDir, "threads.json"), JSON.stringify(plan.threads));
}

interface Repair {
  summary: string;
  findings: { id: number; fixed: boolean; reply: string }[];
}

/** Lets Claude repair the checked-out sync branch, then commits its edits and writes the replies to post. */
function repair(workDir: string, outputDir: string, head: string): void {
  const threads = JSON.parse(
    readFileSync(join(outputDir, "threads.json"), "utf8"),
  ) as ReviewThread[];
  const { result, summary } = claudeFix(
    workDir,
    outputDir,
    "chore(repo): repair the develop-into-next sync",
  );
  // A fix may depend on workflow edits that are only suggested, so threads stay open until a maintainer commits them.
  const diffFile = join(outputDir, WORKFLOW_DIFF);
  const withheld = existsSync(diffFile) && readFileSync(diffFile, "utf8") !== "";
  const findings = result?.findings ?? [];
  const replies = findings.flatMap(({ id, fixed, reply }) => {
    const thread = threads[id - 1];
    return thread
      ? [
          {
            commentId: thread.commentId,
            threadId: thread.threadId,
            body: reply,
            resolve: fixed && !withheld,
          },
        ]
      : [];
  });
  writeFileSync(join(outputDir, "replies.json"), JSON.stringify(replies));
  writeFileSync(
    join(outputDir, "comment.md"),
    [
      repairMarker(head),
      "### Claude repair round",
      "",
      summary,
      "",
      `${findings.filter((finding) => finding.fixed).length} findings fixed, ${findings.filter((finding) => !finding.fixed).length} declined${withheld ? "; a maintainer resolves the fixed threads after committing the workflow suggestions" : ""} (${runLink()}).`,
      "",
    ].join("\n"),
  );
}

export interface Suggestion {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  body: string;
}

/**
 * Turns a `--unified=0` diff of `.github/` into review suggestions on the lines GitHub can anchor them to (`anchors`:
 * the head-side line ranges of the pull request's diff, per path). File additions, deletions, and hunks outside the
 * pull request's diff are returned as a diff to apply by hand.
 */
export function buildSuggestions(
  diff: string,
  anchors: Map<string, [number, number][]>,
  headLine: (path: string, line: number) => string,
): { comments: Suggestion[]; leftover: string } {
  const comments: Suggestion[] = [];
  const leftover: string[] = [];
  for (const section of diff
    .split(/^(?=diff --git )/m)
    .filter((part) => part.startsWith("diff --git "))) {
    const [header = "", ...hunks] = section.split(/^(?=@@ )/m);
    const path = header.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    if (!path || /^(new file|deleted file|old) mode/m.test(header)) {
      leftover.push(section);
      continue;
    }
    const manual: string[] = [];
    for (const hunk of hunks) {
      const [, from = "0", count = "1"] = hunk.match(/^@@ -(\d+)(?:,(\d+))? /) ?? [];
      const added = hunk
        .split("\n")
        .slice(1)
        .filter((line) => line.startsWith("+"))
        .map((line) => line.slice(1));
      const removed = Number(count);
      // An insertion replaces the line it follows with that line plus the new ones.
      const start = removed > 0 ? Number(from) : Math.max(Number(from), 1);
      const end = removed > 0 ? start + removed - 1 : start;
      const lines =
        removed > 0
          ? added
          : Number(from) === 0
            ? [...added, headLine(path, 1)]
            : [headLine(path, start), ...added];
      if (anchors.get(path)?.some(([low, high]) => low <= start && end <= high)) {
        comments.push({
          path,
          line: end,
          ...(start < end ? { start_line: start } : {}),
          side: "RIGHT",
          body: [`${fence(lines.join("\n"))}suggestion`, ...lines, fence(lines.join("\n"))].join(
            "\n",
          ),
        });
      } else {
        manual.push(hunk);
      }
    }
    if (manual.length > 0) {
      leftover.push(header + manual.join(""));
    }
  }
  return { comments, leftover: leftover.join("") };
}

/** Head-side line ranges of each `.github/` file's hunks in the pull request's diff against `next`. */
function pullRequestAnchors(git: GitRunner, head: string): Map<string, [number, number][]> {
  const anchors = new Map<string, [number, number][]>();
  let path = "";
  for (const line of gitOrThrow(git, [
    "diff",
    "--unified=3",
    `origin/next...${head}`,
    "--",
    WORKFLOWS,
  ]).split("\n")) {
    path = line.match(/^\+\+\+ b\/(.+)$/)?.[1] ?? path;
    const [, from, count = "1"] = line.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/) ?? [];
    if (from && Number(count) > 0) {
      anchors.set(path, [
        ...(anchors.get(path) ?? []),
        [Number(from), Number(from) + Number(count) - 1],
      ]);
    }
  }
  return anchors;
}

/** A file's content at a revision, untrimmed so indentation survives into suggestions. */
function showFile(repoDir: string, spec: string): string {
  const result = spawnSync("git", ["show", spec], { cwd: repoDir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git show ${spec} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** Posts the proposed workflow edits on the pushed head as one review a maintainer commits from. */
async function suggest(repoDir: string, outputDir: string): Promise<void> {
  const file = join(outputDir, WORKFLOW_DIFF);
  const diff = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (diff === "") {
    return;
  }
  const git = makeGit(repoDir);
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const head = requireEnv("HEAD_SHA");
  const { comments, leftover } = buildSuggestions(
    diff,
    pullRequestAnchors(git, head),
    (path, line) => showFile(repoDir, `${head}:${path}`).split("\n")[line - 1] ?? "",
  );
  const body = (rest: string) =>
    [
      workflowMarker(head),
      "### Workflow changes for a maintainer",
      "",
      "Claude's edits under `.github/` are not pushed, because workflows on this branch run with repository secrets. Review them, then use **Commit suggestions** so they run.",
      ...(rest ? ["", "Apply these by hand:", "", ...codeFence(rest, "diff")] : []),
    ].join("\n");
  const review = (payload: object) =>
    githubRequest(token, `/repos/${repository}/pulls/${requireEnv("PR")}/reviews`, {
      commit_id: head,
      event: "COMMENT",
      ...payload,
    });
  try {
    await review({ body: body(leftover), comments });
  } catch (error) {
    console.log(`::warning::Suggestions were rejected, posting the diff instead: ${String(error)}`);
    await review({ body: body(diff) });
  }
}

/** A code fence longer than any backtick run in `text`, so the text cannot close it. */
function codeFence(text: string, language: string): string[] {
  return [`${fence(text)}${language}`, text.trimEnd(), fence(text)];
}

function fence(text: string): string {
  return "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
}

/**
 * Refuses a push whose `.github/` differs from what reviewed code gives: each merge must merge `next` and match git's
 * own merge, with conflicted workflows on the `develop` side, and no other commit may touch `.github/`.
 */
export function verifyWorkflows(repoDir: string, base: string, head: string): void {
  const git = makeGit(repoDir);
  for (const commit of gitOrThrow(git, ["rev-list", "--first-parent", `${base}..${head}`])
    .split("\n")
    .filter(Boolean)) {
    const parents = gitOrThrow(git, ["rev-list", "--parents", "-n", "1", commit])
      .split(" ")
      .slice(1);
    if (parents.length < 2) {
      if (git(["diff", "--quiet", `${commit}^`, commit, "--", WORKFLOWS]).status !== 0) {
        throw new Error(
          `${commit} changes ${WORKFLOWS}; workflow edits must come from a maintainer.`,
        );
      }
      continue;
    }
    if (
      parents.length > 2 ||
      git(["merge-base", "--is-ancestor", `${commit}^2`, MERGED_BRANCH]).status !== 0
    ) {
      throw new Error(`${commit} merges a commit outside ${MERGED_BRANCH}.`);
    }
    const merged = git([
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      `${commit}^1`,
      `${commit}^2`,
    ]);
    const [tree = "", ...conflicted] = merged.stdout.split("\n");
    if (merged.status > 1) {
      throw new Error(`git merge-tree failed for ${commit}: ${merged.stderr}`);
    }
    const edited = gitOrThrow(git, ["diff", "--name-only", tree, commit, "--", WORKFLOWS])
      .split("\n")
      .filter(Boolean)
      .filter(
        (path) =>
          !conflicted.includes(path) ||
          git(["--literal-pathspecs", "diff", "--quiet", `${commit}^1`, commit, "--", path])
            .status !== 0,
      );
    if (edited.length > 0) {
      throw new Error(
        `${commit} edits ${edited.join(", ")} beyond git's merge; workflow edits must come from a maintainer.`,
      );
    }
  }
}

if (import.meta.main) {
  const outputDir = requireEnv("OUTPUT_DIR");
  mkdirSync(outputDir, { recursive: true });
  switch (process.argv[2]) {
    case "resolve":
      resolve(requireEnv("WORK_DIR"), outputDir);
      break;
    case "check":
      check(requireEnv("WORK_DIR"), outputDir);
      break;
    case "fix":
      fix(requireEnv("WORK_DIR"), outputDir);
      break;
    case "verify":
      verifyWorkflows(requireEnv("REPO_DIR"), requireEnv("BASE_REF"), requireEnv("HEAD_SHA"));
      break;
    case "suggest":
      await suggest(requireEnv("REPO_DIR"), outputDir);
      break;
    case "collect":
      await collect(outputDir);
      break;
    case "repair":
      repair(requireEnv("WORK_DIR"), outputDir, requireEnv("HEAD_SHA"));
      break;
    default:
      throw new Error(
        "usage: sync-agent.ts resolve | check | fix | verify | suggest | collect | repair",
      );
  }
}
