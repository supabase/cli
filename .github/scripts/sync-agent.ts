/**
 * Lets Claude finish a conflicting `develop` → `next` sync and repair its pull request after CI and the AI review.
 * See apps/cli/docs/release-process.md#claude-resolved-develop-into-next.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AI_REVIEW_MARKER } from "./ai-review/post-review.ts";
import { type CheckRun, fetchPullRequestCheckRuns, REQUIRED_CHECKS } from "./fast-forward.ts";
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
  | { action: "repair"; failures: CheckRun[]; threads: ReviewThread[] };

function repairMarker(head: string): string {
  return `${REPAIR_MARKER} head=${head} -->`;
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
 * repaired gets another round only for new review findings; its remaining failures go to a maintainer.
 */
export function planRepair(state: {
  head: string;
  botComments: string[];
  runs: CheckRun[];
  threads: ReviewThread[];
  reviewRunning: boolean;
}): RepairPlan {
  const { head, botComments, threads } = state;
  if (!botComments.some((body) => body.includes(RESOLVE_MARKER))) {
    return { action: "skip", reason: "Claude did not resolve this pull request." };
  }
  if (botComments.some((body) => body.includes(EXHAUSTED_MARKER))) {
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
  const failures = runs.filter(
    (run) => run.conclusion === "failure" || run.conclusion === "timed_out",
  );
  if (threads.length === 0 && failures.length === 0) {
    return { action: "skip", reason: "Nothing to repair." };
  }
  const rounds = botComments.filter((body) => body.includes(REPAIR_MARKER)).length;
  const headRepaired = botComments.some((body) => body.includes(repairMarker(head)));
  if (rounds >= MAX_REPAIR_ROUNDS || (headRepaired && threads.length === 0)) {
    return { action: "exhausted" };
  }
  return { action: "repair", failures, threads };
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
      .flatMap((line, index) => (/^(<{7}|>{7}) /.test(line) ? [`${path}:${index + 1}`] : []));
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
  const failures = runChecks(workDir);
  if (gitOrThrow(git, ["status", "--porcelain"]) !== "") {
    commit(git, "chore(repo): format the develop-into-next merge");
  }
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

/** Lets Claude fix the checked-out tree from the context files, and commits its edits only when it returned a result. */
function claudeFix(workDir: string, contextDir: string, message: string) {
  const output = runClaude(
    readFileSync(join(PROMPTS_DIR, "repair-prompt.md"), "utf8"),
    "repair.schema.json",
    workDir,
    contextDir,
  );
  const result = typeof output === "object" ? (output as Repair) : undefined;
  const git = makeGit(workDir);
  const changed = result !== undefined && gitOrThrow(git, ["status", "--porcelain"]) !== "";
  if (changed) {
    commit(git, message);
  }
  setOutput("changed", String(changed));
  const workflowEdits = changed
    ? gitOrThrow(git, ["diff", "--name-only", "HEAD~1", "HEAD", "--", ".github/"])
        .split("\n")
        .filter(Boolean)
    : [];
  return {
    result,
    summary:
      result?.summary ??
      `${typeof output === "string" ? output : ""} @supabase/cli please take a look.`,
    workflowNote:
      workflowEdits.length > 0
        ? `@supabase/cli Claude changed files under \`.github/\`, which run in this PR's CI: ${workflowEdits.map((path) => `\`${path}\``).join(", ")}.`
        : undefined,
  };
}

/** Lets Claude fix the quick checks that failed, once; CI runs them again on the pull request. */
function fix(workDir: string, outputDir: string): void {
  const { summary, workflowNote } = claudeFix(
    workDir,
    join(outputDir, "context"),
    "chore(repo): fix the develop-into-next merge",
  );
  appendFileSync(
    join(outputDir, "comment.md"),
    [`**Claude's fix.** ${summary}`, "", ...(workflowNote ? [workflowNote, ""] : []), ""].join(
      "\n",
    ),
  );
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

  commit(git);
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
            nodes { databaseId body path line author { login } pullRequestReview { body } }
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
              pullRequestReview: { body: string } | null;
            }[];
          };
        }[];
      };
    } | null;
  } | null;
}

/** Unresolved AI review threads the release bot has not answered; nobody else's comments reach the agent. */
async function fetchOpenFindings(
  token: string,
  repository: string,
  number: number,
): Promise<ReviewThread[]> {
  const [owner, name] = repository.split("/");
  const page = await githubGraphql<ThreadsPage>(token, THREADS_QUERY, { owner, name, number });
  return (page.repository?.pullRequest?.reviewThreads.nodes ?? []).flatMap((thread) => {
    const [first, ...rest] = thread.comments.nodes;
    if (
      thread.isResolved ||
      !first ||
      !isLogin(first.author?.login, AI_REVIEW_LOGIN) ||
      !first.pullRequestReview?.body.includes(AI_REVIEW_MARKER) ||
      rest.some((comment) => isLogin(comment.author?.login, RELEASE_BOT_LOGIN))
    ) {
      return [];
    }
    return [
      {
        threadId: thread.id,
        commentId: first.databaseId,
        path: first.path,
        line: first.line,
        body: first.body,
      },
    ];
  });
}

async function logTail(token: string, repository: string, jobId: number): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    },
  );
  if (!response.ok) {
    return `(log unavailable: ${response.status})`;
  }
  return (await response.text()).split("\n").slice(-LOG_TAIL_LINES).join("\n");
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
  const comments = await githubRequest<{ user: { login: string } | null; body: string }[]>(
    token,
    `/repos/${repository}/issues/${pull.number}/comments?per_page=100`,
  );
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
    threads: await fetchOpenFindings(token, repository, pull.number),
    reviewRunning: await isReviewRunning(token, repository, pull.number),
  });
  setOutput("action", plan.action);
  setOutput("pr", String(pull.number));
  setOutput("head", pull.head.sha);

  if (plan.action === "skip") {
    console.log(plan.reason);
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
        `## ${run.name} (${run.conclusion})\n\n\`\`\`\`text\n${await logTail(token, repository, run.id)}\n\`\`\`\`\n`,
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
  const { result, summary, workflowNote } = claudeFix(
    workDir,
    join(outputDir, "context"),
    "chore(repo): repair the develop-into-next sync",
  );
  const replies = (result?.findings ?? []).flatMap(({ id, fixed, reply }) => {
    const thread = threads[id - 1];
    return thread
      ? [{ commentId: thread.commentId, threadId: thread.threadId, body: reply, resolve: fixed }]
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
      ...(workflowNote ? [workflowNote, ""] : []),
      `${replies.filter((reply) => reply.resolve).length} findings fixed, ${replies.filter((reply) => !reply.resolve).length} declined (${runLink()}).`,
      "",
    ].join("\n"),
  );
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
    case "collect":
      await collect(outputDir);
      break;
    case "repair":
      repair(requireEnv("WORK_DIR"), outputDir, requireEnv("HEAD_SHA"));
      break;
    default:
      throw new Error("usage: sync-agent.ts resolve | check | fix | collect | repair");
  }
}
