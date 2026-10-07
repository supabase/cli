import {
  type GitRunner,
  githubRequest,
  gitOrThrow,
  isAllowedSyncPair,
  makeGit,
  requireEnv,
} from "./promotion-shared.ts";

export interface SyncPair {
  source: string;
  target: string;
}

export type SyncOutcome =
  | { status: "skipped-missing-branch"; branch: string }
  | { status: "skipped-open-pr"; pullRequest: number }
  | { status: "up-to-date" }
  | { status: "merged" }
  | { status: "conflict-pr-opened"; pullRequest: number; files: string[] };

export interface PullRequestDraft {
  base: string;
  head: string;
  title: string;
  body: string;
  labels: string[];
}

export interface SyncIo {
  git: GitRunner;
  findOpenPullRequest(base: string, head: string): Promise<number | undefined>;
  createPullRequest(draft: PullRequestDraft): Promise<number>;
}

const MAX_PUSH_ATTEMPTS = 3;
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

export function renderConflictPr(
  pair: SyncPair,
  files: string[],
  sourceSha: string,
  targetSha: string,
): { title: string; body: string } {
  const branch = syncBranchName(pair);
  const marker = `<!-- sync-branches source=${pair.source} target=${pair.target} source-sha=${sourceSha} target-sha=${targetSha} -->`;
  const body = [
    marker,
    "",
    `Merging \`${pair.source}\` into \`${pair.target}\` conflicts. This branch starts at the tip of \`${pair.source}\` (\`${sourceSha.slice(0, 7)}\`); \`${pair.target}\` is at \`${targetSha.slice(0, 7)}\`.`,
    "",
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

function fetchBranches(git: GitRunner, pair: SyncPair): void {
  gitOrThrow(git, [
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${pair.source}:refs/remotes/origin/${pair.source}`,
    `+refs/heads/${pair.target}:refs/remotes/origin/${pair.target}`,
  ]);
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
    return { status: "skipped-open-pr", pullRequest: openPullRequest };
  }

  const source = `refs/remotes/origin/${pair.source}`;
  const target = `refs/remotes/origin/${pair.target}`;

  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt += 1) {
    fetchBranches(git, pair);
    if (git(["merge-base", "--is-ancestor", source, target]).status === 0) {
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

    const push = git(["push", "origin", `HEAD:refs/heads/${pair.target}`]);
    if (push.status === 0) {
      return { status: "merged" };
    }
    // A rejected push is only retryable when the target advanced under us.
    const latestTarget = git(["ls-remote", "--heads", "origin", `refs/heads/${pair.target}`]);
    if (latestTarget.status !== 0 || latestTarget.stdout.startsWith(targetSha)) {
      throw new Error(`git push to ${pair.target} failed: ${push.stderr}`);
    }
  }

  throw new Error(`${pair.target} kept moving; gave up after ${MAX_PUSH_ATTEMPTS} attempts`);
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
      const pulls = await githubRequest<{ number: number }[]>(
        token,
        `/repos/${repository}/pulls?${query}`,
      );
      return pulls[0]?.number;
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
        `::notice::${syncBranchName(pair)} PR #${outcome.pullRequest} is open; skipping.`,
      );
      break;
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
      break;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
