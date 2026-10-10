import { appendFileSync } from "node:fs";

import { AI_REVIEW_MARKER } from "./ai-review/post-review.ts";
import { REQUIRED_CHECKS } from "./fast-forward.ts";
import { RELEASE_BOT_LOGIN, githubGraphql, githubRequest, requireEnv } from "./promotion-shared.ts";
import { REVIEW_TEAM_SLUG } from "./sync-publish.ts";
import type { RepairFinding, RepairPlan } from "./sync-repair.ts";
import { REPAIR_MARKER, RESOLUTION_MARKER } from "./sync-resolve.ts";

/** Checks that never settle green on a sync pull request: branch policy fails them to block the merge button. */
export const IGNORED_CHECKS = new Set(["Require fast-forward"]);

const MAX_REPAIR_ROUNDS = 2;
/** How long to wait for the AI review after a resolution before repairing without it. */
const AI_REVIEW_WAIT_MS = 2 * 60 * 60 * 1000;
const ESCALATED_MARKER = "<!-- sync-escalated";
const REPAIR_HEAD = /^<!-- sync-repair round=\d+ head=([0-9a-f]+) -->/;
const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);
const WORKFLOW_BOT_LOGIN = "github-actions[bot]";

export interface SettleCheck {
  name: string;
  status: string;
  conclusion: string | null;
  runId: number;
  jobId: number;
  /** The workflow run attempt; read only for failed checks. */
  attempt: number;
}

export interface SettleComment {
  login: string;
  body: string;
  createdAt: string;
}

/** What the settle step reads about the open sync pull request. Comments are oldest first. */
export interface SettleState {
  pull: { number: number; draft: boolean; headSha: string } | undefined;
  syncRunning: boolean;
  comments: SettleComment[];
  /** The latest check run per name on the head commit. */
  checks: SettleCheck[];
  aiReview: { submittedAt: string; body: string } | undefined;
  /** Unresolved AI review threads the bot has not replied to. */
  findings: RepairFinding[];
  now: number;
}

export type SettleDecision =
  | { action: "wait"; reason: string }
  | { action: "rerun"; runIds: number[] }
  | { action: "ready" }
  | { action: "escalate"; reason: string }
  | { action: "repair"; plan: RepairPlan };

function byBot(comment: SettleComment): boolean {
  return comment.login === RELEASE_BOT_LOGIN;
}

/**
 * Decides the next step for the sync pull request once its head commit settles: wait for CI and the AI review,
 * rerun failed jobs once in case they are flaky, repair, or hand over to a person after the round limit.
 */
export function decideSettle(
  state: SettleState,
  pair: { source: string; target: string },
): SettleDecision {
  const { pull } = state;
  if (!pull) {
    return { action: "wait", reason: "no open sync pull request" };
  }
  if (pull.draft) {
    return { action: "wait", reason: "the sync pull request is a draft" };
  }
  if (state.syncRunning) {
    return { action: "wait", reason: "a sync run owns the branch" };
  }
  const head = pull.headSha;
  if (
    state.comments.some((c) => byBot(c) && c.body.startsWith(`${ESCALATED_MARKER} head=${head} `))
  ) {
    return { action: "wait", reason: "already handed to a maintainer" };
  }

  const checks = state.checks.filter(({ name }) => !IGNORED_CHECKS.has(name));
  const missing = REQUIRED_CHECKS.filter((name) => !checks.some((check) => check.name === name));
  if (missing.length > 0 || checks.some(({ status }) => status !== "completed")) {
    return { action: "wait", reason: "CI is still running" };
  }

  const lineageStart = state.comments.findLastIndex(
    (c) => byBot(c) && c.body.startsWith(RESOLUTION_MARKER),
  );
  const lineage = lineageStart === -1 ? [] : state.comments.slice(lineageStart);
  const resolvedAt = lineageStart === -1 ? undefined : Date.parse(lineage[0]?.createdAt ?? "");
  const reviewed =
    state.aiReview !== undefined &&
    (resolvedAt === undefined || Date.parse(state.aiReview.submittedAt) >= resolvedAt);
  if (!reviewed && resolvedAt !== undefined && state.now - resolvedAt < AI_REVIEW_WAIT_MS) {
    return { action: "wait", reason: "the AI review has not finished" };
  }

  const failing = checks.filter(
    ({ conclusion }) => conclusion !== null && FAILED_CONCLUSIONS.has(conclusion),
  );
  const firstAttempts = [
    ...new Set(failing.filter(({ attempt }) => attempt < 2).map(({ runId }) => runId)),
  ];
  if (firstAttempts.length > 0) {
    return { action: "rerun", runIds: firstAttempts };
  }
  if (failing.length === 0 && state.findings.length === 0) {
    return { action: "ready" };
  }

  const rounds = lineage.filter((c) => byBot(c) && c.body.startsWith(REPAIR_MARKER));
  if (rounds.some((c) => REPAIR_HEAD.exec(c.body)?.[1] === head)) {
    return {
      action: "escalate",
      reason: `a repair round on \`${head.slice(0, 7)}\` already ran, and ${failing.length} failing job${failing.length === 1 ? "" : "s"} and ${state.findings.length} unanswered review finding${state.findings.length === 1 ? "" : "s"} remain`,
    };
  }
  if (rounds.length >= MAX_REPAIR_ROUNDS) {
    return {
      action: "escalate",
      reason: `${rounds.length} repair rounds did not settle the checks and the review`,
    };
  }
  return {
    action: "repair",
    plan: {
      source: pair.source,
      target: pair.target,
      pullRequest: pull.number,
      head,
      round: rounds.length + 1,
      failures: failing.map(({ name, runId, jobId, conclusion }) => ({
        name,
        runId,
        jobId,
        conclusion: conclusion ?? "unknown",
      })),
      findings: state.findings,
      reviewBody: rounds.length === 0 ? (state.aiReview?.body ?? null) : null,
    },
  };
}

interface CheckRunResponse {
  id: number;
  name: string;
  started_at: string | null;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  app: { slug: string } | null;
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 50) {
            nodes {
              databaseId
              body
              path
              line
              author { login }
              pullRequestReview { body }
            }
          }
        }
      }
    }
  }
}`;

interface ReviewThread {
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
}

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ReviewThread[];
      };
    } | null;
  } | null;
}

/** GraphQL drops the `[bot]` suffix from app logins. */
function isLogin(login: string | undefined, bot: string): boolean {
  return login === bot || `${login}[bot]` === bot;
}

async function getAll<T>(token: string, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await githubRequest<T[]>(token, `${path}${separator}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) {
      break;
    }
  }
  return items;
}

async function readState(
  token: string,
  repository: string,
  pair: { source: string; target: string },
): Promise<SettleState> {
  const [owner = "", name = ""] = repository.split("/");
  const base = `/repos/${repository}`;
  const now = Date.now();
  const query = new URLSearchParams({
    state: "open",
    head: `${owner}:sync/${pair.source}-into-${pair.target}`,
    base: pair.target,
  });
  const pulls = await githubRequest<
    { number: number; draft: boolean; head: { sha: string }; user: { login: string } }[]
  >(token, `${base}/pulls?${query}`);
  const pull = pulls.find(({ user }) => user.login === RELEASE_BOT_LOGIN);
  if (!pull) {
    return {
      pull: undefined,
      syncRunning: false,
      comments: [],
      checks: [],
      aiReview: undefined,
      findings: [],
      now,
    };
  }

  const active = await Promise.all(
    ["in_progress", "queued"].map((status) =>
      githubRequest<{ total_count: number }>(
        token,
        `${base}/actions/workflows/sync-branches.yml/runs?status=${status}&per_page=1`,
      ),
    ),
  );
  const comments = (
    await getAll<{ user: { login: string } | null; body: string | null; created_at: string }>(
      token,
      `${base}/issues/${pull.number}/comments`,
    )
  ).map((comment) => ({
    login: comment.user?.login ?? "",
    body: comment.body ?? "",
    createdAt: comment.created_at,
  }));

  const runs: CheckRunResponse[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubRequest<{ total_count: number; check_runs: CheckRunResponse[] }>(
      token,
      `${base}/commits/${pull.head.sha}/check-runs?per_page=100&page=${page}`,
    );
    runs.push(...batch.check_runs);
    if (batch.check_runs.length < 100 || runs.length >= batch.total_count) {
      break;
    }
  }
  // Superseded runs of the same check stay on the commit, cancelled; only the latest one counts.
  const latest = new Map<string, CheckRunResponse>();
  for (const run of runs) {
    const current = latest.get(run.name);
    // A queued run has no start time yet and is the newest.
    const started = (check: CheckRunResponse) => check.started_at ?? "\uffff";
    const newer =
      !current ||
      started(run) > started(current) ||
      (started(run) === started(current) && run.id > current.id);
    if (run.app?.slug === "github-actions" && newer) {
      latest.set(run.name, run);
    }
  }
  const checks: SettleCheck[] = [];
  for (const run of latest.values()) {
    const runId = Number(/\/actions\/runs\/(\d+)/.exec(run.details_url ?? "")?.[1] ?? 0);
    const failed = run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion);
    const attempt = failed
      ? (await githubRequest<{ run_attempt: number }>(token, `${base}/actions/jobs/${run.id}`))
          .run_attempt
      : 1;
    checks.push({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      runId,
      jobId: run.id,
      attempt,
    });
  }

  const reviews = await getAll<{
    user: { login: string } | null;
    body: string;
    submitted_at: string;
  }>(token, `${base}/pulls/${pull.number}/reviews`);
  const aiReview = reviews
    .filter(
      ({ user, body }) => user?.login === WORKFLOW_BOT_LOGIN && body.includes(AI_REVIEW_MARKER),
    )
    .map(({ body, submitted_at }) => ({ body, submittedAt: submitted_at }))
    .at(-1);

  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  do {
    const page: ThreadsPage = await githubGraphql<ThreadsPage>(token, THREADS_QUERY, {
      owner,
      name,
      number: pull.number,
      cursor,
    });
    const connection = page.repository?.pullRequest?.reviewThreads;
    threads.push(...(connection?.nodes ?? []));
    cursor = connection?.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor !== null);
  const findings: RepairFinding[] = [];
  for (const thread of threads) {
    const [first, ...rest] = thread.comments.nodes;
    if (
      thread.isResolved ||
      !first ||
      !isLogin(first.author?.login, WORKFLOW_BOT_LOGIN) ||
      !first.pullRequestReview?.body.includes(AI_REVIEW_MARKER) ||
      rest.some((comment) => isLogin(comment.author?.login, RELEASE_BOT_LOGIN))
    ) {
      continue;
    }
    findings.push({
      threadId: thread.id,
      commentId: first.databaseId,
      path: first.path,
      line: first.line,
      body: first.body,
    });
  }

  return {
    pull: { number: pull.number, draft: pull.draft, headSha: pull.head.sha },
    syncRunning: active.some(({ total_count }) => total_count > 0),
    comments,
    checks,
    aiReview,
    findings,
    now,
  };
}

async function main(): Promise<void> {
  const readToken = requireEnv("READ_TOKEN");
  const repository = requireEnv("REPOSITORY");
  const pair = { source: "develop", target: "next" };
  const state = await readState(readToken, repository, pair);
  const decision = decideSettle(state, pair);
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify(decision, null, 2));
    return;
  }
  const token = requireEnv("GH_TOKEN");
  const pullRequest = state.pull?.number;
  const base = `/repos/${repository}`;

  switch (decision.action) {
    case "wait":
      console.log(`Waiting: ${decision.reason}.`);
      break;
    case "ready":
      console.log(`PR #${pullRequest}: CI passed and every AI review finding has a reply.`);
      break;
    case "rerun":
      for (const runId of decision.runIds) {
        await githubRequest(readToken, `${base}/actions/runs/${runId}/rerun-failed-jobs`, {});
      }
      console.log(`Re-ran the failed jobs of ${decision.runIds.length} workflow run(s) once.`);
      break;
    case "escalate": {
      const owner = repository.split("/")[0] ?? "";
      await githubRequest(token, `${base}/issues/${pullRequest}/comments`, {
        body: [
          `${ESCALATED_MARKER} head=${state.pull?.headSha} -->`,
          `@${owner}/${REVIEW_TEAM_SLUG}: ${decision.reason}, so this pull request is now a draft and needs a maintainer. Fix it on the branch, then mark it ready for review; syncs and repairs resume after that.`,
        ].join("\n"),
      });
      const { node_id: id } = await githubRequest<{ node_id: string }>(
        token,
        `${base}/pulls/${pullRequest}`,
      );
      await githubGraphql(
        token,
        "mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }",
        { id },
      );
      console.log(`::warning::PR #${pullRequest} handed to a maintainer: ${decision.reason}.`);
      break;
    }
    case "repair":
      appendFileSync(requireEnv("GITHUB_OUTPUT"), `repair=${JSON.stringify(decision.plan)}\n`);
      console.log(
        `Repair round ${decision.plan.round}: ${decision.plan.failures.length} failing jobs, ${decision.plan.findings.length} findings.`,
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
