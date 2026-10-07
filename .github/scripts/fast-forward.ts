import { analyzeCommits } from "../../apps/cli/scripts/analyze-commits-title.js";
import {
  type GitRunner,
  MAX_PUSH_ATTEMPTS,
  RELEASE_BOT_LOGIN,
  SYNC_PAIRS,
  githubGraphql,
  githubRequest,
  gitOrThrow,
  makeGit,
  pushMergedTarget,
  requireEnv,
} from "./promotion-shared.ts";

/** Mirrors the contexts the develop ruleset requires. */
export const REQUIRED_CHECKS = [
  "Check code quality",
  "Run unit and integration tests",
  "Run end-to-end tests",
  "Lint Pull Request",
] as const;

export const RELEASE_MAJOR_LABEL = "release-major";

export type PromotionKind = "deploy" | "cut" | "sync";

export interface Promotion {
  kind: PromotionKind;
  source: string;
  target: string;
}

export interface PullRequestAuthor {
  login: string;
  type: string;
}

export interface PullRequest {
  number: number;
  state: string;
  draft: boolean;
  user: PullRequestAuthor;
  head: { sha: string; ref: string };
  base: { ref: string };
  labels: { name: string }[];
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

const GITHUB_ACTIONS_APP_ID = 15368;

const CHECK_ROLLUP_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun {
                    databaseId
                    name
                    status
                    conclusion
                    startedAt
                    completedAt
                    checkSuite {
                      app { databaseId }
                      matchingPullRequests(first: 20) { nodes { number repository { nameWithOwner } } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

export interface RollupContext {
  __typename: string;
  databaseId?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  checkSuite?: {
    app: { databaseId: number } | null;
    matchingPullRequests: { nodes: { number: number; repository: { nameWithOwner: string } }[] };
  } | null;
}

interface RollupPage {
  repository: {
    pullRequest: {
      commits: {
        nodes: {
          commit: {
            oid: string;
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: RollupContext[];
              };
            } | null;
          };
        }[];
      };
    } | null;
  } | null;
}

export type GraphqlQuery = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

/** Keeps GitHub Actions check runs whose suite is attached to this repository's pull request, since fork pull requests can share a number. */
export function actionsCheckRuns(
  contexts: RollupContext[],
  repository: string,
  pullRequestNumber: number,
): CheckRun[] {
  return contexts.flatMap((context) => {
    const { checkSuite } = context;
    if (
      context.__typename !== "CheckRun" ||
      context.databaseId === undefined ||
      context.name === undefined ||
      checkSuite?.app?.databaseId !== GITHUB_ACTIONS_APP_ID ||
      !checkSuite.matchingPullRequests.nodes.some(
        (node) => node.number === pullRequestNumber && node.repository.nameWithOwner === repository,
      )
    ) {
      return [];
    }
    return [
      {
        id: context.databaseId,
        name: context.name,
        status: (context.status ?? "").toLowerCase(),
        conclusion: context.conclusion?.toLowerCase() ?? null,
        startedAt: context.startedAt,
        completedAt: context.completedAt,
      },
    ];
  });
}

/** Reads the check rollup of the pull request's own head commit, so runs of other pull requests on the same SHA never count. */
export async function fetchPullRequestCheckRuns(
  graphql: GraphqlQuery,
  repository: string,
  pullRequestNumber: number,
  headSha: string,
): Promise<CheckRun[]> {
  const [owner = "", name = ""] = repository.split("/");
  const contexts: RollupContext[] = [];
  let cursor: string | null = null;
  do {
    const page = (await graphql(CHECK_ROLLUP_QUERY, {
      owner,
      name,
      number: pullRequestNumber,
      cursor,
    })) as RollupPage;
    const commit = page.repository?.pullRequest?.commits.nodes[0]?.commit;
    if (!commit || commit.oid !== headSha) {
      throw new Error(`Pull request #${pullRequestNumber} head is no longer ${headSha}`);
    }
    const rollup = commit.statusCheckRollup?.contexts;
    if (!rollup) {
      return [];
    }
    contexts.push(...rollup.nodes);
    cursor = rollup.pageInfo.hasNextPage ? rollup.pageInfo.endCursor : null;
  } while (cursor !== null);
  return actionsCheckRuns(contexts, repository, pullRequestNumber);
}

export type CheckEvaluation =
  | { ok: true }
  | {
      ok: false;
      missing: string[];
      pending: string[];
      failing: { name: string; conclusion: string }[];
    };

export interface FastForwardIo {
  git: GitRunner;
  getPullRequest(): Promise<PullRequest>;
  listCheckRuns(sha: string): Promise<CheckRun[]>;
  comment(body: string): Promise<void>;
}

export interface FastForwardInput {
  /** The commit the approving review was submitted against; a local dry run defaults to the live head. */
  reviewCommitId?: string;
  dryRun?: boolean;
}

export type FastForwardOutcome =
  | { status: "ignored"; reason: string }
  | { status: "fast-forwarded"; sha: string }
  | { status: "merged-after-resync"; sha: string }
  | { status: "resynced"; sha: string }
  | { status: "refused"; reason: string }
  | { status: "dry-run"; reason: string };

export function classifyPromotion(
  headRef: string,
  baseRef: string,
  author?: PullRequestAuthor,
): Promotion | undefined {
  if (headRef === "develop" && baseRef === "main") {
    return { kind: "deploy", source: "develop", target: "main" };
  }
  if (headRef === "next" && baseRef === "develop") {
    return { kind: "cut", source: "next", target: "develop" };
  }
  const pair = findSyncPair(headRef, baseRef);
  if (pair && author?.login === RELEASE_BOT_LOGIN && author.type === "Bot") {
    return { kind: "sync", source: pair.source, target: pair.target };
  }
  return undefined;
}

function findSyncPair(headRef: string, baseRef: string) {
  return SYNC_PAIRS.find(
    ({ source, target }) => headRef === `sync/${source}-into-${target}` && baseRef === target,
  );
}

function recency(run: CheckRun): string {
  return run.completedAt ?? run.startedAt ?? "";
}

export function evaluateRequiredChecks(
  runs: CheckRun[],
  required: readonly string[] = REQUIRED_CHECKS,
): CheckEvaluation {
  const missing: string[] = [];
  const pending: string[] = [];
  const failing: { name: string; conclusion: string }[] = [];

  for (const name of required) {
    const latest = runs
      .filter((run) => run.name === name)
      .reduce<CheckRun | undefined>((best, run) => {
        if (!best) {
          return run;
        }
        const byTime = recency(run).localeCompare(recency(best));
        return byTime > 0 || (byTime === 0 && run.id > best.id) ? run : best;
      }, undefined);

    if (!latest) {
      missing.push(name);
    } else if (latest.status !== "completed") {
      pending.push(name);
    } else if (latest.conclusion !== "success") {
      failing.push({ name, conclusion: latest.conclusion ?? "unknown" });
    }
  }

  if (missing.length === 0 && pending.length === 0 && failing.length === 0) {
    return { ok: true };
  }
  return { ok: false, missing, pending, failing };
}

function compareStableTags(a: string, b: string): number {
  const left = a.slice(1).split(".").map(Number);
  const right = b.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function lastStableTag(tags: string[]): string | undefined {
  return tags
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort(compareStableTags)
    .at(-1);
}

export function isMajorPromotion(git: GitRunner, headSha: string, baseRef: string): boolean {
  const merged = gitOrThrow(git, ["tag", "--merged", `refs/remotes/origin/${baseRef}`]);
  const tag = lastStableTag(merged.split("\n").filter(Boolean));
  if (!tag) {
    throw new Error(`No stable release tag is reachable from ${baseRef}; cannot check for a major`);
  }
  const log = gitOrThrow(git, ["log", "--format=%H%x1f%B%x1e", `${tag}..${headSha}`]);
  const commits = log
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = "", message = ""] = record.split("\x1f");
      return { hash, message };
    });
  return analyzeCommits({}, { commits, logger: { log() {} } }) === "major";
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function describeCheckFailure(evaluation: Extract<CheckEvaluation, { ok: false }>): string {
  const rows = [
    ...evaluation.missing.map((name) => `| ${name} | missing |`),
    ...evaluation.pending.map((name) => `| ${name} | not finished |`),
    ...evaluation.failing.map(({ name, conclusion }) => `| ${name} | ${conclusion} |`),
  ];
  return ["| Check | State |", "| -- | -- |", ...rows].join("\n");
}

async function refuse(
  io: FastForwardIo,
  input: FastForwardInput,
  reason: string,
  comment: string = reason,
): Promise<FastForwardOutcome> {
  await notify(io, input, comment);
  return { status: "refused", reason };
}

async function notify(io: FastForwardIo, input: FastForwardInput, body: string): Promise<void> {
  if (input.dryRun) {
    console.log(`[dry-run] would comment: ${body}`);
    return;
  }
  await io.comment(body);
}

function pushSha(
  io: FastForwardIo,
  input: FastForwardInput,
  sha: string,
  branch: string,
): { ok: true } | { ok: false; stderr: string } {
  if (input.dryRun) {
    console.log(`[dry-run] would push ${sha} to ${branch}`);
    return { ok: true };
  }
  const result = io.git(["push", "origin", `${sha}:refs/heads/${branch}`]);
  return result.status === 0 ? { ok: true } : { ok: false, stderr: result.stderr };
}

async function resyncSyncBranch(
  io: FastForwardIo,
  input: FastForwardInput,
  promotion: Promotion,
  headSha: string,
  syncBranch: string,
): Promise<FastForwardOutcome> {
  const { git } = io;
  const { target, source } = promotion;
  const targetRef = `refs/remotes/origin/${target}`;
  let resyncedSha = headSha;

  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt += 1) {
    gitOrThrow(git, [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${target}:${targetRef}`,
      `+refs/heads/${source}:refs/remotes/origin/${source}`,
    ]);
    const targetSha = gitOrThrow(git, ["rev-parse", targetRef]);
    gitOrThrow(git, ["checkout", "--detach", headSha]);
    for (const ref of [target, source]) {
      const merge = git(["merge", "--no-edit", `refs/remotes/origin/${ref}`]);
      if (merge.status !== 0) {
        const files = git(["diff", "--name-only", "--diff-filter=U"]).stdout;
        git(["merge", "--abort"]);
        const list = files
          .split("\n")
          .filter(Boolean)
          .map((file) => `- \`${file}\``)
          .join("\n");
        return refuse(
          io,
          input,
          `Merging ${ref} into ${syncBranch} conflicts`,
          `${target} moved since approval and merging \`${ref}\` into \`${syncBranch}\` conflicts:\n\n${list}\n\nResolve on the branch and re-approve.`,
        );
      }
    }
    resyncedSha = gitOrThrow(git, ["rev-parse", "HEAD"]);

    // A clean merge on top of the approved head carries the same trust as a clean sync, which also lands untested.
    if (input.dryRun) {
      console.log(`[dry-run] would push ${resyncedSha} to ${target}`);
      return { status: "dry-run", reason: `would land the re-synced ${syncBranch} on ${target}` };
    }
    if (pushMergedTarget(git, target, targetSha) === "pushed") {
      git(["push", "origin", "--delete", syncBranch]);
      await io.comment(
        `\`${target}\` moved since approval, so I merged the latest \`${target}\` and \`${source}\` into the approved head and landed it as ${short(resyncedSha)}.`,
      );
      return { status: "merged-after-resync", sha: resyncedSha };
    }
  }

  gitOrThrow(git, ["push", "origin", `${resyncedSha}:refs/heads/${syncBranch}`]);
  await io.comment(
    `\`${target}\` kept moving, so I merged the latest \`${target}\` and \`${source}\` into \`${syncBranch}\` (${short(resyncedSha)}). Re-approve once checks pass.`,
  );
  return { status: "resynced", sha: resyncedSha };
}

export async function runFastForward(
  io: FastForwardIo,
  input: FastForwardInput = {},
): Promise<FastForwardOutcome> {
  const { git } = io;
  const pullRequest = await io.getPullRequest();
  const promotion = classifyPromotion(pullRequest.head.ref, pullRequest.base.ref, pullRequest.user);
  const syncPair = findSyncPair(pullRequest.head.ref, pullRequest.base.ref);
  if (!promotion && !syncPair) {
    return { status: "ignored", reason: "not a fast-forward pull request" };
  }
  if (pullRequest.state !== "open") {
    return { status: "ignored", reason: `pull request is ${pullRequest.state}` };
  }
  if (!promotion) {
    return refuse(
      io,
      input,
      `sync pull request was not opened by ${RELEASE_BOT_LOGIN}`,
      `Not fast-forwarding \`${syncPair?.target}\`: sync pull requests must be opened by the \`Sync branches\` workflow. Close this pull request and run \`gh workflow run sync-branches.yml -f pair=${syncPair?.source}-into-${syncPair?.target}\` to open one.`,
    );
  }

  const headSha = pullRequest.head.sha;
  const approvedSha = input.reviewCommitId ?? headSha;
  if (pullRequest.draft) {
    return refuse(io, input, "pull request is a draft");
  }
  if (approvedSha !== headSha) {
    return refuse(
      io,
      input,
      `approved ${short(approvedSha)} but head is ${short(headSha)}`,
      `You approved \`${short(approvedSha)}\` but the head is now \`${short(headSha)}\`. Re-approve the current head to fast-forward \`${promotion.target}\`.`,
    );
  }

  const evaluation = evaluateRequiredChecks(await io.listCheckRuns(headSha));
  if (!evaluation.ok) {
    return refuse(
      io,
      input,
      "required checks are not green on the head commit",
      `Not fast-forwarding \`${promotion.target}\`: required checks are not green on \`${short(headSha)}\`.\n\n${describeCheckFailure(evaluation)}\n\nOnce they pass (re-run or push as needed), re-approve.`,
    );
  }

  if (promotion.kind === "deploy") {
    gitOrThrow(git, ["fetch", "--no-tags", "origin", "+refs/tags/*:refs/tags/*"]);
  }
  const fetchRefs = [
    `+refs/heads/${promotion.target}:refs/remotes/origin/${promotion.target}`,
    `+refs/pull/${pullRequest.number}/head:refs/ff/pr-head`,
    ...(promotion.kind === "sync"
      ? [`+refs/heads/${promotion.source}:refs/remotes/origin/${promotion.source}`]
      : []),
  ];
  gitOrThrow(git, ["fetch", "--no-tags", "origin", ...fetchRefs]);

  const fetchedHead = gitOrThrow(git, ["rev-parse", "refs/ff/pr-head"]);
  if (fetchedHead !== headSha) {
    return refuse(
      io,
      input,
      "head moved while fast-forwarding",
      `The head moved to \`${short(fetchedHead)}\` while fast-forwarding. Re-approve the current head.`,
    );
  }

  if (
    promotion.target === "main" &&
    !pullRequest.labels.some(({ name }) => name === RELEASE_MAJOR_LABEL) &&
    isMajorPromotion(git, headSha, promotion.target)
  ) {
    return refuse(
      io,
      input,
      "major release without the release-major label",
      `This deploy would release a new major version. Add the \`${RELEASE_MAJOR_LABEL}\` label and re-approve to proceed.`,
    );
  }

  const targetRef = `refs/remotes/origin/${promotion.target}`;
  const canFastForward = (): boolean =>
    git(["merge-base", "--is-ancestor", targetRef, headSha]).status === 0;

  let moved = !canFastForward();
  if (!moved) {
    const push = pushSha(io, input, headSha, promotion.target);
    if (!push.ok) {
      gitOrThrow(git, [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${promotion.target}:${targetRef}`,
      ]);
      if (canFastForward()) {
        throw new Error(`git push to ${promotion.target} failed: ${push.stderr}`);
      }
      moved = true;
    }
  }

  if (moved) {
    if (promotion.kind === "sync") {
      return resyncSyncBranch(io, input, promotion, headSha, pullRequest.head.ref);
    }
    return refuse(
      io,
      input,
      `${promotion.target} moved since approval`,
      `\`${promotion.target}\` moved since approval, so it can no longer be fast-forwarded to \`${short(headSha)}\`. Update the branch and re-approve.`,
    );
  }

  if (input.dryRun) {
    return { status: "dry-run", reason: `would fast-forward ${promotion.target}` };
  }
  if (promotion.kind === "sync") {
    git(["push", "origin", "--delete", pullRequest.head.ref]);
  }
  return { status: "fast-forwarded", sha: headSha };
}

function makeIo(token: string, repository: string, prNumber: number): FastForwardIo {
  return {
    git: makeGit(process.cwd()),
    getPullRequest: () =>
      githubRequest<PullRequest>(token, `/repos/${repository}/pulls/${prNumber}`),
    listCheckRuns: (sha) =>
      fetchPullRequestCheckRuns(
        (query, variables) => githubGraphql(token, query, variables),
        repository,
        prNumber,
        sha,
      ),
    async comment(body) {
      await githubRequest(token, `/repos/${repository}/issues/${prNumber}/comments`, {
        body,
      });
    },
  };
}

function parseArguments(args: string[]): { prNumber: number; dryRun: boolean } {
  const dryRun = args.includes("--dry-run");
  const flag = args.indexOf("--pr");
  const prNumber = Number(flag >= 0 ? args[flag + 1] : process.env.PR_NUMBER);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error("Usage: fast-forward.ts [--pr <number>] [--dry-run] (or set PR_NUMBER)");
  }
  return { prNumber, dryRun };
}

async function main(): Promise<void> {
  const { prNumber, dryRun } = parseArguments(process.argv.slice(2));
  const repository = process.env.REPOSITORY ?? requireEnv("GITHUB_REPOSITORY");
  const io = makeIo(requireEnv("GH_TOKEN"), repository, prNumber);
  const reviewCommitId = process.env.REVIEW_COMMIT_ID || undefined;
  if (!reviewCommitId && !dryRun) {
    throw new Error("REVIEW_COMMIT_ID is required");
  }
  const outcome = await runFastForward(io, { reviewCommitId, dryRun });
  console.log(JSON.stringify(outcome));
  if (outcome.status === "refused") {
    console.error(`::error::${outcome.reason}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
