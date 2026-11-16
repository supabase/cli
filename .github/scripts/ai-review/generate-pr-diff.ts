import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface GeneratePrDiffOptions {
  repositoryPath: string;
  prNumber: number;
  baseRef: string;
  outputPath: string;
  /** Commit to diff instead of the PR's current head, so a push during the review is not reviewed unseen. */
  headSha?: string;
  /** For a `develop` → `next` sync, where to write the diff of what the sync branch itself changed. */
  syncResolutionPath?: string;
}

const SYNC_BRANCH = "sync/develop-into-next";

/** Whether the PR is the same-repository `develop` → `next` sync, whose sides were each reviewed already. */
export function isSyncPullRequest(pr: {
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
}): boolean {
  return pr.baseRefName === "next" && pr.headRefName === SYNC_BRANCH && !pr.isCrossRepository;
}

function runGit(repositoryPath: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * Commits on the sync branch that neither `develop` nor `next` has, oldest first: merges show only how their
 * resolution differs from git's automatic merge (`--remerge-diff`), other commits their full change.
 */
function syncResolutionDiff(repositoryPath: string, baseRef: string, headRef: string): string {
  const developRef = "refs/ai-review/develop";
  runGit(repositoryPath, [
    "fetch",
    "--force",
    "--no-tags",
    "origin",
    `+refs/heads/develop:${developRef}`,
  ]);
  const commits = runGit(repositoryPath, [
    "rev-list",
    "--reverse",
    "--topo-order",
    headRef,
    "--not",
    baseRef,
    developRef,
  ])
    .split("\n")
    .filter(Boolean);
  return commits
    .map((commit) =>
      runGit(repositoryPath, [
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--remerge-diff",
        "--format=### Commit %H: %s%n",
        commit,
        "--",
      ]),
    )
    .join("\n");
}

function validateInputs(prNumber: number, baseRef: string, headSha?: string): void {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
  if (baseRef.length === 0) {
    throw new Error("Base ref must not be empty");
  }
  if (headSha !== undefined && !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`Invalid head SHA: ${headSha}`);
  }
}

export function generatePrDiff(options: GeneratePrDiffOptions): void {
  const repositoryPath = resolve(options.repositoryPath);
  const outputPath = resolve(options.outputPath);
  validateInputs(options.prNumber, options.baseRef, options.headSha);
  runGit(repositoryPath, ["check-ref-format", `refs/heads/${options.baseRef}`]);

  const baseRef = "refs/ai-review/base";
  const headRef = "refs/ai-review/head";
  runGit(repositoryPath, [
    "fetch",
    "--force",
    "--no-tags",
    "origin",
    `+refs/heads/${options.baseRef}:${baseRef}`,
    `+${options.headSha ?? `refs/pull/${options.prNumber}/head`}:${headRef}`,
  ]);

  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const output = openSync(temporaryPath, "wx");
  try {
    try {
      const result = spawnSync(
        "git",
        ["diff", "--no-ext-diff", "--no-textconv", `${baseRef}...${headRef}`, "--"],
        {
          cwd: repositoryPath,
          stdio: ["ignore", output, "pipe"],
          encoding: "utf8",
        },
      );
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(`git diff failed: ${result.stderr.trim()}`);
      }
    } finally {
      closeSync(output);
    }
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  if (options.syncResolutionPath !== undefined) {
    const syncPath = resolve(options.syncResolutionPath);
    rmSync(syncPath, { force: true });
    writeFileSync(syncPath, syncResolutionDiff(repositoryPath, baseRef, headRef));
  }
}

function fetchPullRequest(prNumber: number): {
  baseRefName: string;
  headRefName: string;
  isCrossRepository: boolean;
} {
  const result = spawnSync(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      process.env.GITHUB_REPOSITORY ?? "",
      "--json",
      "baseRefName,headRefName,isCrossRepository",
    ],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`gh pr view failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

function parseArguments(args: string[]): GeneratePrDiffOptions {
  if (args.length < 2 || args.length > 3) {
    throw new Error("Usage: generate-pr-diff.ts <pr-number> <base-ref> [head-sha]");
  }
  return {
    repositoryPath: process.cwd(),
    prNumber: Number(args[0]),
    baseRef: args[1] ?? "",
    outputPath: "/tmp/ai-review/pr.diff",
    headSha: args[2] || undefined,
  };
}

const SYNC_RESOLUTION_PATH = "/tmp/ai-review/sync-resolution.diff";

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    rmSync(SYNC_RESOLUTION_PATH, { force: true });
    generatePrDiff({
      ...options,
      ...(options.baseRef === "next" &&
        isSyncPullRequest(fetchPullRequest(options.prNumber)) && {
          syncResolutionPath: SYNC_RESOLUTION_PATH,
        }),
    });
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
