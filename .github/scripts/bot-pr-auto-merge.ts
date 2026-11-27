/**
 * Bot PR sweeper: approves and queues routine bot pull requests against `develop`.
 *
 * Only a fixed set of bot-owned branch families is eligible, and only while every push to the
 * branch came from that family's bot. A push by anyone else removes the bot approval and
 * auto-merge. A maintainer hold (`do not merge` label, draft, or a dismissed bot approval) revokes
 * the same way and is never re-approved. Set `DRY_RUN=true` to log decisions without writing. The workflow runs only from
 * the default branch and never checks out PR code.
 */
import { appendFileSync } from "node:fs";

export const APPROVER_LOGIN = "supabase-oss";
export const BASE_BRANCH = "develop";

const SWEEP_APP_LOGIN = "supabase-cli-releaser";
const DO_NOT_MERGE_LABEL = "do not merge";
const PROTECTED_HEADS = new Set(["develop", "main", "next"]);
const FORBIDDEN_HEAD_PREFIXES = ["sync/", "release-notes/", "hotfix/", "backport/"];
const ALLOWED_SYNC_HEAD = "sync/api-package";
const MAX_ACTIVITY_PAGES = 10;

export interface BotFamily {
  bot: string;
  matches: (headRef: string) => boolean;
}

export const BOT_FAMILIES: readonly BotFamily[] = [
  { bot: "dependabot[bot]", matches: (ref) => ref.startsWith("dependabot/") },
  {
    bot: "supabase-cli-releaser[bot]",
    matches: (ref) =>
      ref === ALLOWED_SYNC_HEAD || ref.startsWith("slim-bump/") || ref.startsWith("slim-hotfix/"),
  },
];

export interface BotPr {
  number: number;
  nodeId: string;
  draft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  headRepo: string | null;
  authorLogin: string;
  labels: string[];
  assignees: string[];
  autoMergeEnabled: boolean;
}

export interface ActivityEvent {
  type: string;
  actor: string | null;
  after: string;
}

export interface PrReview {
  id: number;
  user: string | null;
  state: string;
}

export interface BotPrState {
  open: boolean;
  draft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  labels: string[];
  autoMergeEnabled: boolean;
  inMergeQueue: boolean;
  autoMergeByBot: boolean;
  queuedByBot: boolean;
}

export type Provenance =
  | { verdict: "trusted" }
  | { verdict: "pending"; reason: string }
  | { verdict: "tainted"; actor: string };

export interface BotPrIo {
  /** List open PRs whose base is `develop`. */
  listPrs: () => Promise<BotPr[]>;
  /** Branch activity, newest first, back to and including the most recent `branch_creation`. */
  listBranchActivity: (headRef: string) => Promise<ActivityEvent[]>;
  listReviews: (prNumber: number) => Promise<PrReview[]>;
  /** Approve the PR head as the approver account. Throws `ApprovalGuardViolation` for an unapprovable PR. */
  approve: (pr: BotPr) => Promise<void>;
  /** Read the PR's current state. */
  refresh: (pr: BotPr) => Promise<BotPrState>;
  /**
   * Enable squash auto-merge pinned to the PR head, or enqueue the PR when auto-merge is
   * unavailable. Throws `ApprovalGuardViolation` for an unapprovable PR.
   */
  queue: (pr: BotPr) => Promise<void>;
  dequeue: (pr: BotPr) => Promise<void>;
  disableAutoMerge: (pr: BotPr) => Promise<void>;
  dismissReview: (pr: BotPr, reviewId: number, message: string) => Promise<void>;
  assignApprover: (pr: BotPr) => Promise<void>;
}

export class ApprovalGuardViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalGuardViolation";
  }
}

/** Throws unless the PR is a plain `develop` PR that a bot approval may never ship to production. */
export function assertApprovable(
  pr: Pick<BotPr, "number" | "baseRef" | "headRef" | "labels">,
): void {
  const fail = (reason: string): never => {
    throw new ApprovalGuardViolation(`PR #${pr.number} is not approvable: ${reason}`);
  };
  if (pr.baseRef !== BASE_BRANCH) {
    fail(`base is \`${pr.baseRef}\``);
  }
  if (PROTECTED_HEADS.has(pr.headRef)) {
    fail(`head is \`${pr.headRef}\``);
  }
  if (
    pr.headRef !== ALLOWED_SYNC_HEAD &&
    FORBIDDEN_HEAD_PREFIXES.some((prefix) => pr.headRef.startsWith(prefix))
  ) {
    fail(`head \`${pr.headRef}\` is a promotion or release branch`);
  }
  if (pr.labels.some((label) => label.toLowerCase() === DO_NOT_MERGE_LABEL)) {
    fail(`it is labelled \`${DO_NOT_MERGE_LABEL}\``);
  }
}

/** The bot that owns the PR's head branch family, or undefined when the PR is not eligible. */
export function eligibleBot(pr: BotPr, repository: string): string | undefined {
  if (pr.baseRef !== BASE_BRANCH || pr.headRepo !== repository) {
    return undefined;
  }
  const family = BOT_FAMILIES.find((candidate) => candidate.matches(pr.headRef));
  return family && family.bot === pr.authorLogin ? family.bot : undefined;
}

/** Classify who pushed the branch, from activity newest first. */
export function assessProvenance(
  events: readonly ActivityEvent[],
  bot: string,
  headSha: string,
): Provenance {
  let creationFound = false;
  let newest: ActivityEvent | undefined;
  for (const event of events) {
    if (event.actor !== bot) {
      return { verdict: "tainted", actor: event.actor ?? "an unknown actor" };
    }
    newest ??= event;
    if (event.type === "branch_creation") {
      creationFound = true;
      break;
    }
  }
  if (!creationFound) {
    return { verdict: "pending", reason: "branch creation not in activity yet" };
  }
  if (newest?.after !== headSha) {
    return { verdict: "pending", reason: "activity does not yet show the PR head" };
  }
  return { verdict: "trusted" };
}

/** The reviewer's latest approving or blocking review; comments and pending reviews are skipped. */
export function latestApproverReview(reviews: readonly PrReview[]): PrReview | undefined {
  return reviews
    .filter(
      (review) =>
        review.user?.toLowerCase() === APPROVER_LOGIN &&
        ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state),
    )
    .at(-1);
}

export interface BotPrSweepEntry {
  number: number;
  headRef: string;
  verdict: string;
  actions: string[];
  error?: string;
  guardViolation?: boolean;
}

export interface BotPrSweepOptions {
  repository: string;
  dryRun: boolean;
}

function holdReason(state: BotPrState, approval: PrReview | undefined): string | undefined {
  if (state.labels.some((label) => label.toLowerCase() === DO_NOT_MERGE_LABEL)) {
    return `labelled \`${DO_NOT_MERGE_LABEL}\``;
  }
  if (state.draft) {
    return "draft";
  }
  if (approval?.state === "DISMISSED") {
    return "approval dismissed";
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reviewers other than the approver whose latest verdict is an approval. */
function otherApprovers(reviews: readonly PrReview[]): string[] {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const user = review.user?.toLowerCase();
    if (
      user &&
      user !== APPROVER_LOGIN &&
      ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)
    ) {
      latest.set(user, review.state);
    }
  }
  return [...latest].filter(([, state]) => state === "APPROVED").map(([user]) => user);
}

function hasHoldLabel(labels: readonly string[]): boolean {
  return labels.some((label) => label.toLowerCase() === DO_NOT_MERGE_LABEL);
}

function toLive(pr: BotPr, state: BotPrState): BotPr {
  return {
    ...pr,
    draft: state.draft,
    baseRef: state.baseRef,
    headRef: state.headRef,
    headSha: state.headSha,
    labels: state.labels,
    autoMergeEnabled: state.autoMergeEnabled,
  };
}

async function handlePr(
  io: BotPrIo,
  pr: BotPr,
  bot: string,
  dryRun: boolean,
  actions: string[],
): Promise<string> {
  let provenance: Provenance;
  try {
    provenance = assessProvenance(await io.listBranchActivity(pr.headRef), bot, pr.headSha);
  } catch (error) {
    provenance = { verdict: "pending", reason: `activity unavailable: ${errorMessage(error)}` };
  }
  const state = await io.refresh(pr);
  if (!state.open) {
    return "pending (closed)";
  }

  const live = toLive(pr, state);
  const failures: string[] = [];
  const act = async (label: string, run: () => Promise<void>): Promise<void> => {
    if (dryRun) {
      console.log(`[dry-run] PR #${pr.number}: would ${label}`);
      actions.push(`would ${label}`);
      return;
    }
    await run();
    actions.push(label);
  };
  const attempt = async (label: string, run: () => Promise<void>): Promise<void> => {
    try {
      await act(label, run);
    } catch (error) {
      failures.push(`${label}: ${errorMessage(error)}`);
    }
  };

  let reviews: PrReview[] = [];
  let reviewsError: unknown;
  try {
    reviews = await io.listReviews(pr.number);
  } catch (error) {
    reviewsError = error;
  }
  const latest = latestApproverReview(reviews);
  const hold = holdReason(state, latest);

  const revoke = async (message: string): Promise<void> => {
    const botApprovals = reviews.filter(
      (review) => review.user?.toLowerCase() === APPROVER_LOGIN && review.state === "APPROVED",
    );
    // Only the sweep's own automation is withdrawn; without the review list, fail closed.
    const withdrawMerge = reviewsError !== undefined || otherApprovers(reviews).length === 0;
    if (withdrawMerge && state.inMergeQueue && state.queuedByBot) {
      await attempt("dequeue", () => io.dequeue(live));
    }
    if (withdrawMerge && state.autoMergeEnabled && state.autoMergeByBot) {
      await attempt("disable auto-merge", () => io.disableAutoMerge(live));
    }
    if (reviewsError) {
      failures.push(`list reviews: ${errorMessage(reviewsError)}`);
    }
    for (const approval of botApprovals) {
      await attempt("dismiss approval", () => io.dismissReview(live, approval.id, message));
    }
    if (failures.length > 0) {
      throw new Error(`Revocation incomplete for PR #${pr.number}: ${failures.join("; ")}`);
    }
  };

  if (hold) {
    await revoke(
      "This pull request is on hold, so the automatic approval no longer applies. A maintainer needs to approve it.",
    );
    return `held (${hold})`;
  }
  if (provenance.verdict === "tainted") {
    await revoke(
      `${provenance.actor} pushed to this branch, so the automatic approval no longer applies. A maintainer needs to review this pull request.`,
    );
    return `tainted (push by ${provenance.actor})`;
  }
  if (provenance.verdict === "pending") {
    return `pending (${provenance.reason})`;
  }
  if (state.headSha !== pr.headSha) {
    return "pending (head moved)";
  }
  if (reviewsError) {
    throw reviewsError;
  }

  const recheck = async (): Promise<BotPr | undefined> => {
    const fresh = await io.refresh(pr);
    if (
      !fresh.open ||
      fresh.headSha !== state.headSha ||
      fresh.baseRef !== BASE_BRANCH ||
      fresh.draft ||
      hasHoldLabel(fresh.labels)
    ) {
      return undefined;
    }
    const freshPr = toLive(pr, fresh);
    assertApprovable(freshPr);
    return freshPr;
  };
  const changed = "pending (changed during sweep)";

  assertApprovable(live);
  if (!pr.assignees.includes(APPROVER_LOGIN)) {
    await act("assign approver", () => io.assignApprover(live));
  }
  if (latest?.state !== "APPROVED") {
    const fresh = await recheck();
    if (!fresh) {
      return changed;
    }
    await act("approve", () => io.approve(fresh));
  }
  if (!state.inMergeQueue && !state.autoMergeEnabled) {
    const fresh = await recheck();
    if (!fresh) {
      return changed;
    }
    await act("queue", () => io.queue(fresh));
  }
  return "trusted";
}

/**
 * Sweep every open `develop` PR, approving and queueing trusted bot PRs and revoking both on
 * tainted or held ones. Per-PR failures are recorded and do not stop the sweep.
 */
export async function sweepBotPrs(
  io: BotPrIo,
  { repository, dryRun }: BotPrSweepOptions,
): Promise<BotPrSweepEntry[]> {
  const entries: BotPrSweepEntry[] = [];
  for (const pr of await io.listPrs()) {
    const bot = eligibleBot(pr, repository);
    if (!bot) {
      continue;
    }
    const actions: string[] = [];
    try {
      const verdict = await handlePr(io, pr, bot, dryRun, actions);
      entries.push({ number: pr.number, headRef: pr.headRef, verdict, actions });
    } catch (error) {
      entries.push({
        number: pr.number,
        headRef: pr.headRef,
        verdict: "error",
        actions,
        error: error instanceof Error ? error.message : String(error),
        guardViolation: error instanceof ApprovalGuardViolation,
      });
    }
  }
  return entries;
}

export function renderSummary(entries: readonly BotPrSweepEntry[], dryRun: boolean): string {
  const lines = [`## Bot PR auto-merge${dryRun ? " (dry run)" : ""}`, ""];
  if (entries.length === 0) {
    return [...lines, "No eligible bot pull requests."].join("\n");
  }
  lines.push("| PR | Branch | Verdict | Actions |", "| --- | --- | --- | --- |");
  for (const entry of entries) {
    const outcome = entry.error ? `error: ${entry.error}` : entry.verdict;
    lines.push(
      `| #${entry.number} | \`${entry.headRef}\` | ${outcome.replaceAll("|", "\\|")} | ${entry.actions.join(", ") || "none"} |`,
    );
  }
  return lines.join("\n");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function githubFetch(
  url: string,
  token: string,
  init: Omit<RequestInit, "headers"> = {},
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub request failed (${response.status}) for ${url}: ${body}`);
  }
  return response;
}

async function graphql<T = unknown>(token: string, query: string, variables: object): Promise<T> {
  const response = await githubFetch("https://api.github.com/graphql", token, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
  return payload.data as T;
}

// GraphQL reports the app as `supabase-cli-releaser` on some fields and with a `[bot]` suffix on others.
function isSweepApp(login: string | undefined): boolean {
  return login?.replace(/\[bot\]$/, "") === SWEEP_APP_LOGIN;
}

interface GraphqlPullRequest {
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  labels: { nodes: Array<{ name: string }> };
  autoMergeRequest: { enabledBy: { login: string } | null } | null;
  isInMergeQueue: boolean;
  mergeQueueEntry: { enqueuer: { login: string } | null } | null;
}

interface RestPull {
  number: number;
  node_id: string;
  draft?: boolean;
  user: { login: string } | null;
  base: { ref: string };
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  labels: Array<{ name: string }>;
  assignees?: Array<{ login: string }> | null;
  auto_merge: unknown;
}

interface RestActivity {
  activity_type: string;
  after: string;
  actor: { login: string } | null;
}

interface RestReview {
  id: number;
  user: { login: string } | null;
  state: string;
}

export interface BotPrIoConfig {
  repository: string;
  appToken: string;
  approverToken: string;
}

export function createBotPrIo({ repository, appToken, approverToken }: BotPrIoConfig): BotPrIo {
  const base = `https://api.github.com/repos/${repository}`;
  return {
    async listPrs() {
      const prs: BotPr[] = [];
      for (let page = 1; ; page++) {
        const response = await githubFetch(
          `${base}/pulls?state=open&base=${BASE_BRANCH}&per_page=100&page=${page}`,
          appToken,
        );
        const batch = (await response.json()) as RestPull[];
        for (const pr of batch) {
          prs.push({
            number: pr.number,
            nodeId: pr.node_id,
            draft: pr.draft ?? false,
            baseRef: pr.base.ref,
            headRef: pr.head.ref,
            headSha: pr.head.sha,
            headRepo: pr.head.repo?.full_name ?? null,
            authorLogin: pr.user?.login ?? "",
            labels: pr.labels.map((label) => label.name),
            assignees: (pr.assignees ?? []).map((assignee) => assignee.login),
            autoMergeEnabled: pr.auto_merge != null,
          });
        }
        if (batch.length < 100) {
          return prs;
        }
      }
    },

    async listBranchActivity(headRef) {
      const events: ActivityEvent[] = [];
      let url: string | undefined =
        `${base}/activity?ref=${encodeURIComponent(`refs/heads/${headRef}`)}&per_page=100`;
      for (let page = 0; url && page < MAX_ACTIVITY_PAGES; page++) {
        const response: Response = await githubFetch(url, appToken);
        for (const item of (await response.json()) as RestActivity[]) {
          events.push({
            type: item.activity_type,
            actor: item.actor?.login ?? null,
            after: item.after,
          });
          if (item.activity_type === "branch_creation") {
            return events;
          }
        }
        url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
      }
      return events;
    },

    async listReviews(prNumber) {
      const reviews: PrReview[] = [];
      for (let page = 1; ; page++) {
        const response = await githubFetch(
          `${base}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
          appToken,
        );
        const batch = (await response.json()) as RestReview[];
        reviews.push(
          ...batch.map((r) => ({ id: r.id, user: r.user?.login ?? null, state: r.state })),
        );
        if (batch.length < 100) {
          return reviews;
        }
      }
    },

    async approve(pr) {
      assertApprovable(pr);
      await githubFetch(`${base}/pulls/${pr.number}/reviews`, approverToken, {
        method: "POST",
        body: JSON.stringify({ event: "APPROVE", commit_id: pr.headSha }),
      });
    },

    async refresh(pr) {
      const [owner, name] = repository.split("/");
      const data = await graphql<{ repository: { pullRequest: GraphqlPullRequest } }>(
        appToken,
        `
          query ($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                state
                isDraft
                baseRefName
                headRefName
                headRefOid
                labels(first: 100) {
                  nodes {
                    name
                  }
                }
                autoMergeRequest {
                  enabledBy {
                    login
                  }
                }
                isInMergeQueue
                mergeQueueEntry {
                  enqueuer {
                    login
                  }
                }
              }
            }
          }
        `,
        { owner, name, number: pr.number },
      );
      const current = data.repository.pullRequest;
      return {
        open: current.state === "OPEN",
        draft: current.isDraft,
        baseRef: current.baseRefName,
        headRef: current.headRefName,
        headSha: current.headRefOid,
        labels: current.labels.nodes.map((label) => label.name),
        autoMergeEnabled: current.autoMergeRequest != null,
        inMergeQueue: current.isInMergeQueue,
        autoMergeByBot: isSweepApp(current.autoMergeRequest?.enabledBy?.login),
        queuedByBot: isSweepApp(current.mergeQueueEntry?.enqueuer?.login),
      };
    },

    async queue(pr) {
      assertApprovable(pr);
      const variables = { id: pr.nodeId, oid: pr.headSha };
      try {
        await graphql(
          appToken,
          `
            mutation ($id: ID!, $oid: GitObjectID!) {
              enablePullRequestAutoMerge(
                input: { pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $oid }
              ) {
                clientMutationId
              }
            }
          `,
          variables,
        );
      } catch (autoMergeError) {
        try {
          await graphql(
            appToken,
            `
              mutation ($id: ID!, $oid: GitObjectID!) {
                enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $oid }) {
                  clientMutationId
                }
              }
            `,
            variables,
          );
        } catch (enqueueError) {
          const message = (error: unknown) =>
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `Could not queue PR #${pr.number}: auto-merge failed (${message(autoMergeError)}); enqueue failed (${message(enqueueError)})`,
          );
        }
      }
    },

    async dequeue(pr) {
      await graphql(
        appToken,
        `
          mutation ($id: ID!) {
            dequeuePullRequest(input: { id: $id }) {
              clientMutationId
            }
          }
        `,
        { id: pr.nodeId },
      );
    },

    async disableAutoMerge(pr) {
      await graphql(
        appToken,
        `
          mutation ($id: ID!) {
            disablePullRequestAutoMerge(input: { pullRequestId: $id }) {
              clientMutationId
            }
          }
        `,
        { id: pr.nodeId },
      );
    },

    async dismissReview(pr, reviewId, message) {
      await githubFetch(
        `${base}/pulls/${pr.number}/reviews/${reviewId}/dismissals`,
        approverToken,
        {
          method: "PUT",
          body: JSON.stringify({ message, event: "DISMISS" }),
        },
      );
    },

    async assignApprover(pr) {
      await githubFetch(`${base}/issues/${pr.number}/assignees`, appToken, {
        method: "POST",
        body: JSON.stringify({ assignees: [APPROVER_LOGIN] }),
      });
    },
  };
}

async function main(): Promise<void> {
  const repository = requireEnv("GITHUB_REPOSITORY");
  const dryRun = /^(1|true)$/i.test(process.env.DRY_RUN ?? "");
  const io = createBotPrIo({
    repository,
    appToken: requireEnv("APP_TOKEN"),
    approverToken: requireEnv("APPROVER_TOKEN"),
  });

  const entries = await sweepBotPrs(io, { repository, dryRun });
  for (const entry of entries) {
    const detail = entry.error ?? entry.verdict;
    console.log(
      `PR #${entry.number} (${entry.headRef}): ${detail}; actions: ${entry.actions.join(", ") || "none"}`,
    );
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${renderSummary(entries, dryRun)}\n`);
  }

  const failed = entries.filter((entry) => entry.error);
  if (failed.length > 0) {
    throw new Error(failed.map((entry) => entry.error).join("; "));
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
