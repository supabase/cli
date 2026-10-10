import { appendFileSync } from "node:fs";

import {
  type GitRunner,
  MAX_PUSH_ATTEMPTS,
  githubRequest,
  gitOrThrow,
  isAllowedSyncPair,
  makeGit,
  pushMergedTarget,
  requireEnv,
} from "./promotion-shared.ts";

export interface SyncPair {
  source: string;
  target: string;
}

/** Merges an agent must finish: replayed onto `base` in order, then published to the sync branch. */
export interface ResolutionPlan {
  source: string;
  target: string;
  /** The target tip, or the head of the open sync pull request. */
  base: string;
  merges: { ref: string; sha: string }[];
  /** Sync branch tip the publish push leases against; null when the branch must not exist. */
  expectedSyncHead: string | null;
  pullRequest: number | null;
}

export type SyncOutcome =
  | { status: "skipped-missing-branch"; branch: string }
  | { status: "skipped-open-pr"; pullRequest: number }
  | { status: "up-to-date" }
  | { status: "merged" }
  | { status: "conflict-pr-opened"; pullRequest: number; files: string[] }
  | { status: "pr-updated"; pullRequest: number }
  | { status: "needs-resolution"; plan: ResolutionPlan };

export interface OpenPullRequest {
  number: number;
  draft: boolean;
}

export interface PullRequestDraft {
  base: string;
  head: string;
  title: string;
  body: string;
  labels: string[];
}

export interface SyncIo {
  git: GitRunner;
  findOpenPullRequest(base: string, head: string): Promise<OpenPullRequest | undefined>;
  createPullRequest(draft: PullRequestDraft): Promise<number>;
}

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function parsePair(value: string): SyncPair {
  const separator = value.indexOf("-into-");
  const source = value.slice(0, Math.max(separator, 0));
  const target = value.slice(separator + "-into-".length);
  if (separator < 0 || !BRANCH_NAME.test(source) || !BRANCH_NAME.test(target)) {
    throw new Error(`Invalid sync pair "${value}"; expected <source>-into-<target>`);
  }
  return { source, target };
}

export function syncBranchName({ source, target }: SyncPair): string {
  return `sync/${source}-into-${target}`;
}

/** Pairs whose conflicts an agent resolves; the others open a conflict pull request for a person. */
export function resolvesWithAgent({ source, target }: SyncPair): boolean {
  return source === "develop" && target === "next";
}

/**
 * Paths the sync branch runs with repository secrets. An agent may change one only to resolve its conflict, and
 * every such resolution needs a maintainer's decision.
 */
export const PROTECTED_PATH_PREFIX = ".github/";

export function isProtectedPath(path: string): boolean {
  return path.startsWith(PROTECTED_PATH_PREFIX);
}

/**
 * The lines the agent wrote between `base` and `head`: what each merge adds beyond git's own merge of its parents,
 * and what each plain commit adds.
 */
export function agentWrittenText(git: GitRunner, base: string, head: string): string {
  const added: string[] = [];
  let commit = head;
  while (commit !== base) {
    const parents = gitOrThrow(git, ["rev-list", "--parents", "-n", "1", commit])
      .split(" ")
      .slice(1);
    const [first = "", second] = parents;
    const from = second
      ? (git(["merge-tree", "--write-tree", "--no-messages", first, second]).stdout.split(
          "\n",
        )[0] ?? "")
      : first;
    const diff = gitOrThrow(git, ["diff", "--no-color", "--text", "--unified=0", from, commit]);
    // File headers (`+++ b/path`) come before a file's first hunk; inside a hunk every `+` line is content,
    // including content that itself starts with `++`.
    let inHunk = false;
    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git ")) {
        inHunk = false;
      } else if (line.startsWith("@@")) {
        inHunk = true;
      } else if (inHunk && line.startsWith("+")) {
        added.push(line.slice(1));
      }
    }
    if (!first) {
      break;
    }
    commit = first;
  }
  return added.join("\n");
}

/**
 * Compares a merge commit's protected paths with git's own merge of its two parents: `conflicted` paths are the
 * ones the resolution had to decide, `strayEdits` the ones it changed without a conflict.
 */
export function protectedPathChanges(
  git: GitRunner,
  mergeCommit: string,
): { conflicted: string[]; strayEdits: string[] } {
  const mergeTree = git([
    "-c",
    "core.quotePath=false",
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    `${mergeCommit}^1`,
    `${mergeCommit}^2`,
  ]);
  const [tree = "", ...conflictedPaths] = mergeTree.stdout.split("\n");
  if (mergeTree.status > 1 || !/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new Error(`git merge-tree failed for ${mergeCommit}: ${mergeTree.stderr}`);
  }
  const conflicted = [...new Set(conflictedPaths.filter(isProtectedPath))];
  const changed = gitOrThrow(git, [
    "diff",
    "-z",
    "--name-only",
    tree,
    mergeCommit,
    "--",
    PROTECTED_PATH_PREFIX,
  ])
    .split("\0")
    .filter(Boolean);
  return { conflicted, strayEdits: changed.filter((path) => !conflicted.includes(path)) };
}

export function renderConflictPr(
  pair: SyncPair,
  files: string[],
  sourceSha: string,
  targetSha: string,
  reason?: string,
): { title: string; body: string } {
  const branch = syncBranchName(pair);
  const marker = `<!-- sync-branches source=${pair.source} target=${pair.target} source-sha=${sourceSha} target-sha=${targetSha} -->`;
  const body = [
    marker,
    "",
    `Merging \`${pair.source}\` into \`${pair.target}\` conflicts. This branch starts at the tip of \`${pair.source}\` (\`${sourceSha.slice(0, 7)}\`); \`${pair.target}\` is at \`${targetSha.slice(0, 7)}\`.`,
    "",
    ...(reason ? [reason, ""] : []),
    "Conflicting files:",
    "",
    ...files.map((file) => `- \`${file}\``),
    "",
    "To resolve:",
    "",
    "```sh",
    "git fetch origin",
    `git switch ${branch}`,
    `git merge origin/${pair.target}`,
    "# resolve the conflicts, then commit",
    `git push origin ${branch}`,
    "```",
    "",
    `Approve to fast-forward \`${pair.target}\`; do not use the merge button.`,
    "",
  ].join("\n");
  return { title: `chore(repo): sync ${pair.source} into ${pair.target}`, body };
}

function remoteBranchExists(git: GitRunner, branch: string): boolean {
  const result = git(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
  if (result.status === 0) {
    return true;
  }
  if (result.status === 2) {
    return false;
  }
  throw new Error(`git ls-remote failed: ${result.stderr}`);
}

function remoteBranchSha(git: GitRunner, branch: string): string | null {
  const line = gitOrThrow(git, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  return line.split("\t")[0] || null;
}

function fetchBranches(git: GitRunner, branches: string[]): void {
  gitOrThrow(git, [
    "fetch",
    "--no-tags",
    "origin",
    ...branches.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`),
  ]);
}

function isAncestor(git: GitRunner, ancestor: string, descendant: string): boolean {
  return git(["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

/**
 * Brings an open agent-resolved sync pull request up to date with the target and the source.
 * A draft, or a head that has not merged anything yet, waits for a person.
 */
async function updateSyncPullRequest(
  git: GitRunner,
  pair: SyncPair,
  pullRequest: OpenPullRequest,
): Promise<SyncOutcome> {
  const syncBranch = syncBranchName(pair);
  fetchBranches(git, [pair.source, pair.target, syncBranch]);
  const syncHead = gitOrThrow(git, ["rev-parse", `refs/remotes/origin/${syncBranch}`]);
  if (pullRequest.draft || isAncestor(git, syncHead, `refs/remotes/origin/${pair.source}`)) {
    return { status: "skipped-open-pr", pullRequest: pullRequest.number };
  }

  const merges = [pair.target, pair.source]
    .filter((ref) => !isAncestor(git, `refs/remotes/origin/${ref}`, syncHead))
    .map((ref) => ({ ref, sha: gitOrThrow(git, ["rev-parse", `refs/remotes/origin/${ref}`]) }));
  if (merges.length === 0) {
    return { status: "up-to-date" };
  }

  gitOrThrow(git, ["checkout", "--detach", syncHead]);
  for (const { sha } of merges) {
    if (git(["merge", "--no-ff", "--no-edit", sha]).status !== 0) {
      gitOrThrow(git, ["merge", "--abort"]);
      return {
        status: "needs-resolution",
        plan: {
          source: pair.source,
          target: pair.target,
          base: syncHead,
          merges,
          expectedSyncHead: syncHead,
          pullRequest: pullRequest.number,
        },
      };
    }
  }
  // The lease fails if an approval landed and deleted the branch meanwhile; the next run starts over.
  gitOrThrow(git, [
    "push",
    `--force-with-lease=refs/heads/${syncBranch}:${syncHead}`,
    "origin",
    `HEAD:refs/heads/${syncBranch}`,
  ]);
  return { status: "pr-updated", pullRequest: pullRequest.number };
}

export async function syncBranches(io: SyncIo, pair: SyncPair): Promise<SyncOutcome> {
  const { git } = io;
  for (const branch of [pair.target, pair.source]) {
    if (!remoteBranchExists(git, branch)) {
      return { status: "skipped-missing-branch", branch };
    }
  }

  const syncBranch = syncBranchName(pair);
  const openPullRequest = await io.findOpenPullRequest(pair.target, syncBranch);
  if (openPullRequest !== undefined) {
    if (resolvesWithAgent(pair)) {
      return updateSyncPullRequest(git, pair, openPullRequest);
    }
    return { status: "skipped-open-pr", pullRequest: openPullRequest.number };
  }

  const source = `refs/remotes/origin/${pair.source}`;
  const target = `refs/remotes/origin/${pair.target}`;

  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt += 1) {
    fetchBranches(git, [pair.source, pair.target]);
    if (isAncestor(git, source, target)) {
      return { status: "up-to-date" };
    }

    const targetSha = gitOrThrow(git, ["rev-parse", target]);
    const sourceSha = gitOrThrow(git, ["rev-parse", source]);
    gitOrThrow(git, ["checkout", "--detach", targetSha]);

    const merge = git(["merge", "--no-edit", sourceSha]);
    if (merge.status !== 0) {
      const files = gitOrThrow(git, ["diff", "--name-only", "--diff-filter=U"])
        .split("\n")
        .filter(Boolean);
      if (files.length === 0) {
        throw new Error(`git merge failed without conflicts: ${merge.stderr || merge.stdout}`);
      }
      gitOrThrow(git, ["merge", "--abort"]);
      if (resolvesWithAgent(pair)) {
        return {
          status: "needs-resolution",
          plan: {
            source: pair.source,
            target: pair.target,
            base: targetSha,
            merges: [{ ref: pair.source, sha: sourceSha }],
            expectedSyncHead: remoteBranchSha(git, syncBranch),
            pullRequest: null,
          },
        };
      }
      gitOrThrow(git, ["push", "--force", "origin", `${sourceSha}:refs/heads/${syncBranch}`]);
      const { title, body } = renderConflictPr(pair, files, sourceSha, targetSha);
      const pullRequest = await io.createPullRequest({
        base: pair.target,
        head: syncBranch,
        title,
        body,
        labels: ["do not merge"],
      });
      return { status: "conflict-pr-opened", pullRequest, files };
    }

    if (pushMergedTarget(git, pair.target, targetSha) === "pushed") {
      return { status: "merged" };
    }
  }

  throw new Error(`${pair.target} kept moving; gave up after ${MAX_PUSH_ATTEMPTS} attempts`);
}

function appendOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    appendFileSync(file, `${name}=${value}\n`);
  }
}

function makeIo(token: string, repository: string): SyncIo {
  const owner = repository.split("/")[0] ?? "";
  return {
    git: makeGit(process.cwd()),
    async findOpenPullRequest(base, head) {
      const query = new URLSearchParams({
        state: "open",
        base,
        head: `${owner}:${head}`,
      });
      const pulls = await githubRequest<OpenPullRequest[]>(
        token,
        `/repos/${repository}/pulls?${query}`,
      );
      const pull = pulls[0];
      return pull && { number: pull.number, draft: pull.draft };
    },
    async createPullRequest({ labels, ...draft }) {
      const created = await githubRequest<{ number: number }>(
        token,
        `/repos/${repository}/pulls`,
        draft,
      );
      await githubRequest(token, `/repos/${repository}/issues/${created.number}/labels`, {
        labels,
      });
      return created.number;
    },
  };
}

async function main(): Promise<void> {
  const pairArgument = process.argv[2];
  if (!pairArgument) {
    throw new Error("Usage: sync-branches.ts <source>-into-<target>");
  }
  const pair = parsePair(pairArgument);
  if (!isAllowedSyncPair(pair.source, pair.target)) {
    throw new Error(`"${pairArgument}" is not a sync pair`);
  }
  const outcome = await syncBranches(
    makeIo(requireEnv("GH_TOKEN"), requireEnv("REPOSITORY")),
    pair,
  );
  switch (outcome.status) {
    case "skipped-missing-branch":
      console.log(`::notice::${outcome.branch} does not exist; skipping ${pairArgument}.`);
      break;
    case "skipped-open-pr":
      console.log(
        `::notice::${syncBranchName(pair)} PR #${outcome.pullRequest} is open and waiting for a person; skipping.`,
      );
      break;
    case "pr-updated":
      console.log(`Merged cleanly into ${syncBranchName(pair)} for PR #${outcome.pullRequest}.`);
      break;
    case "needs-resolution": {
      appendOutput("plan", JSON.stringify(outcome.plan));
      console.log(`Conflicts merging into ${syncBranchName(pair)}; handing off to the agent.`);
      break;
    }
    case "up-to-date":
      console.log(`${pair.target} already contains ${pair.source}.`);
      break;
    case "merged":
      console.log(`Merged ${pair.source} into ${pair.target}.`);
      break;
    case "conflict-pr-opened":
      console.log(
        `::warning::Opened PR #${outcome.pullRequest} for conflicts in ${outcome.files.join(", ")}.`,
      );
      appendOutput("conflict_pr", String(outcome.pullRequest));
      break;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
