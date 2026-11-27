/**
 * Bot PR sweeper: approves and queues routine bot pull requests against `develop`.
 *
 * Only a fixed set of bot-owned branch families is eligible, and only while every push to the
 * branch came from that family's bot. A push by anyone else removes the bot approval and
 * auto-merge. Set `DRY_RUN=true` to log decisions without writing. The workflow runs only from
 * the default branch and never checks out PR code.
 */
import { appendFileSync } from "node:fs";

export const APPROVER_LOGIN = "supabase-oss";
export const BASE_BRANCH = "develop";

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
    matches: (ref) => ref === ALLOWED_SYNC_HEAD || ref.startsWith("slim-bump/"),
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
  /** Enable squash auto-merge pinned to the PR head. Throws `ApprovalGuardViolation` for an unapprovable PR. */
  enableAutoMerge: (pr: BotPr) => Promise<void>;
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
  if (pr.draft || pr.baseRef !== BASE_BRANCH || pr.headRepo !== repository) {
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
    if (!["branch_creation", "push", "force_push"].includes(event.type)) {
      continue;
    }
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

async function handlePr(
  io: BotPrIo,
  pr: BotPr,
  bot: string,
  dryRun: boolean,
): Promise<Pick<BotPrSweepEntry, "verdict" | "actions">> {
  const provenance = assessProvenance(await io.listBranchActivity(pr.headRef), bot, pr.headSha);
  const actions: string[] = [];
  const act = async (label: string, run: () => Promise<void>): Promise<void> => {
    if (dryRun) {
      console.log(`[dry-run] PR #${pr.number}: would ${label}`);
      actions.push(`would ${label}`);
      return;
    }
    await run();
    actions.push(label);
  };

  if (provenance.verdict === "pending") {
    return { verdict: `pending (${provenance.reason})`, actions };
  }

  const approval = latestApproverReview(await io.listReviews(pr.number));
  const approved = approval?.state === "APPROVED";

  if (provenance.verdict === "tainted") {
    if (approved && approval) {
      await act("dismiss approval", () =>
        io.dismissReview(
          pr,
          approval.id,
          `${provenance.actor} pushed to this branch, so the automatic approval no longer applies. A maintainer needs to review this pull request.`,
        ),
      );
    }
    if (pr.autoMergeEnabled) {
      await act("disable auto-merge", () => io.disableAutoMerge(pr));
    }
    return { verdict: `tainted (push by ${provenance.actor})`, actions };
  }

  assertApprovable(pr);
  if (!pr.assignees.includes(APPROVER_LOGIN)) {
    await act("assign approver", () => io.assignApprover(pr));
  }
  if (!approved) {
    await act("approve", () => io.approve(pr));
  }
  if (!pr.autoMergeEnabled) {
    await act("enable auto-merge", () => io.enableAutoMerge(pr));
  }
  return { verdict: "trusted", actions };
}

/**
 * Sweep every open `develop` PR, approving and queueing trusted bot PRs and revoking both on
 * tainted ones. Per-PR failures are recorded and do not stop the sweep.
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
    try {
      entries.push({
        number: pr.number,
        headRef: pr.headRef,
        ...(await handlePr(io, pr, bot, dryRun)),
      });
    } catch (error) {
      entries.push({
        number: pr.number,
        headRef: pr.headRef,
        verdict: "error",
        actions: [],
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

async function graphql(token: string, query: string, variables: object): Promise<void> {
  const response = await githubFetch("https://api.github.com/graphql", token, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  const payload = (await response.json()) as { errors?: Array<{ message: string }> };
  if (payload.errors?.length) {
    throw new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`);
  }
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

    async enableAutoMerge(pr) {
      assertApprovable(pr);
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
        { id: pr.nodeId, oid: pr.headSha },
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

  const violations = entries.filter((entry) => entry.guardViolation);
  if (violations.length > 0) {
    throw new Error(violations.map((entry) => entry.error).join("; "));
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
