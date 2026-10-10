import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type GitRunner,
  githubGraphql,
  githubRequest,
  gitOrThrow,
  makeGit,
  requireEnv,
} from "./promotion-shared.ts";
import {
  PROTECTED_PATH_PREFIX,
  type PullRequestDraft,
  type ResolutionPlan,
  protectedPathChanges,
  renderConflictPr,
  syncBranchName,
} from "./sync-branches.ts";
import type { AgentDecision } from "./sync-agent.ts";
import type { RepairPlan, RepairResult } from "./sync-repair.ts";
import {
  type AgentResolution,
  type CheckResult,
  REPAIR_RESULT_MARKER,
  RESOLUTION_MARKER,
  type ResolveResult,
} from "./sync-resolve.ts";

/** Team asked to review resolutions that need a decision. */
export const REVIEW_TEAM_SLUG = "cli";

const MAX_BODY_LENGTH = 60_000;
/** Fix commits a run may stack on top of its merges. */
const MAX_FOLLOW_UPS = 5;

export interface PublishIo {
  git: GitRunner;
  createPullRequest(draft: PullRequestDraft): Promise<number>;
  updatePullRequestBody(pullRequest: number, body: string): Promise<void>;
  convertToDraft(pullRequest: number): Promise<void>;
  comment(pullRequest: number, body: string): Promise<void>;
  requestTeamReview(pullRequest: number, team: string): Promise<void>;
  dispatchAiReview(pullRequest: number): Promise<void>;
}

export interface RepairIo {
  git: GitRunner;
  comment(pullRequest: number, body: string): Promise<void>;
  replyToReviewComment(pullRequest: number, commentId: number, body: string): Promise<void>;
  resolveReviewThread(threadId: string): Promise<void>;
  requestTeamReview(pullRequest: number, team: string): Promise<void>;
}

export interface PublishOptions {
  bundlePath: string;
  model: string;
  owner: string;
  runUrl: string;
}

export type PublishOutcome =
  | { status: "rejected"; reason: string }
  | { status: "published"; pullRequest: number; decisions: number }
  | { status: "needs-maintainer"; pullRequest: number };

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** Agent text is rendered into bot comments; this keeps it from pinging anyone or forging a hidden marker. */
function neutralize(text: string): string {
  return text.replace(/@(?=[\w-])/g, "@\u200b").replace(/<!--/g, "&lt;!--");
}

/** An agent-reported path as inline code, unable to close its code span. */
function pathCode(path: string): string {
  return `\`${neutralize(path).replaceAll("`", "'")}\``;
}

function capped(body: string): string {
  return body.length <= MAX_BODY_LENGTH
    ? body
    : `${body.slice(0, MAX_BODY_LENGTH)}\n\n… truncated; see the workflow run.`;
}

function changedProtectedPaths(git: GitRunner, commits: string[]): string[] {
  const paths = commits.flatMap((commit) =>
    gitOrThrow(git, [
      "diff",
      "-z",
      "--name-only",
      `${commit}^`,
      commit,
      "--",
      PROTECTED_PATH_PREFIX,
    ])
      .split("\0")
      .filter(Boolean),
  );
  return [...new Set(paths)];
}

/**
 * Checks that every commit from `from` (exclusive) to `head` is a plain, non-merge commit, at most a few, and
 * returns the protected paths they change.
 */
export function validateFollowUps(
  git: GitRunner,
  from: string,
  head: string,
): { error: string } | { protectedEdits: string[] } {
  const commits: string[] = [];
  let commit = head;
  while (commit !== from) {
    const parents = gitOrThrow(git, ["rev-list", "--parents", "-n", "1", commit])
      .split(" ")
      .slice(1);
    if (parents.length !== 1 || commits.length === MAX_FOLLOW_UPS) {
      return {
        error: `\`${short(head)}\` is not a few plain commits on top of \`${short(from)}\`.`,
      };
    }
    commits.push(commit);
    commit = parents[0] ?? "";
  }
  return { protectedEdits: changedProtectedPaths(git, commits) };
}

/**
 * Checks that `head` is the plan's merges on top of its base, followed by at most a few fix commits. Merges may
 * change protected paths only where they conflicted. Returns those conflicted paths per merge, in plan order, and
 * the protected paths the fix commits change.
 */
export function validateResolvedHistory(
  git: GitRunner,
  plan: ResolutionPlan,
  head: string,
): { error: string } | { protectedConflicts: string[][]; protectedEdits: string[] } {
  const followUps: string[] = [];
  let commit = head;
  for (;;) {
    const parents = gitOrThrow(git, ["rev-list", "--parents", "-n", "1", commit])
      .split(" ")
      .slice(1);
    if (parents.length !== 1 || commit === plan.base || followUps.length === MAX_FOLLOW_UPS) {
      break;
    }
    followUps.push(commit);
    commit = parents[0] ?? "";
  }

  const protectedConflicts: string[][] = [];
  for (const merge of [...plan.merges].reverse()) {
    const parents = gitOrThrow(git, ["rev-list", "--parents", "-n", "1", commit])
      .split(" ")
      .slice(1);
    if (parents.length !== 2 || parents[1] !== merge.sha) {
      return {
        error: `\`${short(commit)}\` is not the merge of \`${merge.ref}\` (\`${short(merge.sha)}\`) the plan expects.`,
      };
    }
    const { conflicted, strayEdits } = protectedPathChanges(git, commit);
    if (strayEdits.length > 0) {
      return {
        error: `\`${short(commit)}\` changes \`${strayEdits.join("`, `")}\` under \`${PROTECTED_PATH_PREFIX}\` without a conflict.`,
      };
    }
    protectedConflicts.unshift(conflicted);
    commit = parents[0] ?? "";
  }
  return commit === plan.base
    ? { protectedConflicts, protectedEdits: changedProtectedPaths(git, followUps) }
    : { error: `The history does not start at \`${short(plan.base)}\`.` };
}

/** One decision per protected path not already raised, since workflows on the sync branch run with secrets. */
export function protectedDecisions(
  paths: string[],
  raised: AgentDecision[],
  question: string,
): AgentDecision[] {
  const covered = new Set(raised.flatMap(({ paths: decided }) => decided));
  return paths
    .filter((path) => !covered.has(path))
    .map((path) => ({
      paths: [path],
      question,
      chosen: "The change on this branch.",
      alternative: "Fix it by hand on the sync branch.",
    }));
}

const CONFLICT_QUESTION =
  "This workflow file conflicted and runs with repository secrets. Is the resolution right?";
const EDIT_QUESTION =
  "Claude changed this workflow file to fix the checks, and it runs with repository secrets. Is the change right?";

/** Adds a decision for every protected path the merges resolved or the fix commits changed, whatever the agent reported. */
export function withProtectedDecisions(
  result: Extract<ResolveResult, { status: "resolved" }>,
  protectedConflicts: string[][],
  protectedEdits: string[] = [],
): Extract<ResolveResult, { status: "resolved" }> {
  const merges = result.merges.map((merge, index) =>
    merge.resolution === null
      ? merge
      : {
          ...merge,
          resolution: {
            ...merge.resolution,
            decisions: [
              ...merge.resolution.decisions,
              ...protectedDecisions(
                protectedConflicts[index] ?? [],
                merge.resolution.decisions,
                CONFLICT_QUESTION,
              ),
            ],
          },
        },
  );
  const raised = [
    ...merges.flatMap(({ resolution }) => resolution?.decisions ?? []),
    ...(result.check?.decisions ?? []),
  ];
  const editDecisions = protectedDecisions(protectedEdits, raised, EDIT_QUESTION);
  const check: CheckResult = result.check ?? { passed: true, fixes: [], decisions: [] };
  return {
    ...result,
    merges,
    ...(result.check || editDecisions.length > 0
      ? { check: { ...check, decisions: [...check.decisions, ...editDecisions] } }
      : {}),
  };
}

function decisionCount(result: Extract<ResolveResult, { status: "resolved" }>): number {
  return result.merges.reduce(
    (total, { resolution }) => total + (resolution?.decisions.length ?? 0),
    result.check?.decisions.length ?? 0,
  );
}

function renderDecisions(decisions: AgentResolution["decisions"]): string[] {
  if (decisions.length === 0) {
    return [];
  }
  return [
    "",
    "**Needs a decision**",
    "",
    ...decisions.flatMap((decision, index) => [
      `${index + 1}. ${neutralize(decision.question)} (${decision.paths.map(pathCode).join(", ")})`,
      `   - Chosen: ${neutralize(decision.chosen)}`,
      `   - Alternative: ${neutralize(decision.alternative)}`,
    ]),
  ];
}

function renderMerge(ref: string, sha: string, resolution: AgentResolution | null): string[] {
  const heading = `#### \`${ref}\` (\`${short(sha)}\`)`;
  if (resolution === null) {
    return [heading, "", "Merged cleanly."];
  }
  const lines = [
    heading,
    "",
    neutralize(resolution.summary),
    ...renderDecisions(resolution.decisions),
  ];
  lines.push("", "**Resolved files**", "");
  for (const file of resolution.files) {
    const precedent = file.precedent === null ? "" : ` (follows #${file.precedent})`;
    lines.push(`- ${pathCode(file.path)}: ${neutralize(file.resolution)}${precedent}`);
  }
  for (const path of resolution.deletedFiles) {
    lines.push(`- ${pathCode(path)}: deleted`);
  }
  return lines;
}

function renderCheck(check: CheckResult): string[] {
  const fixes = check.fixes.map(
    ({ path, resolution }) => `- ${pathCode(path)}: ${neutralize(resolution)}`,
  );
  const decisions = renderDecisions(check.decisions);
  if (check.passed) {
    return fixes.length === 0
      ? ["#### Quality checks", "", "Passed on the merged tree.", ...decisions]
      : [
          "#### Quality checks",
          "",
          "Passed after these changes to the merged tree:",
          "",
          ...fixes,
          ...decisions,
        ];
  }
  return [
    "#### Quality checks",
    "",
    "**The checks still fail.** Fix them on the branch before approving.",
    ...(fixes.length > 0 ? ["", "Already changed:", "", ...fixes] : []),
    ...decisions,
    "",
    "<details><summary>Check output</summary>",
    "",
    "````text",
    (check.remaining ?? "").slice(-6000),
    "````",
    "",
    "</details>",
  ];
}

export function renderResolutionRecord(
  plan: ResolutionPlan,
  result: Extract<ResolveResult, { status: "resolved" }>,
  options: Pick<PublishOptions, "model" | "owner" | "runUrl">,
): string {
  const decisions = decisionCount(result);
  const lines = [
    RESOLUTION_MARKER,
    `### Resolution for \`${short(result.head)}\``,
    "",
    `Claude (\`${options.model}\`) merged into \`${syncBranchName(plan)}\`. [Workflow run](${options.runUrl})`,
  ];
  for (const { ref, sha, resolution } of result.merges) {
    lines.push("", ...renderMerge(ref, sha, resolution));
  }
  if (result.check) {
    lines.push("", ...renderCheck(result.check));
  }
  lines.push(
    "",
    decisions > 0
      ? `@${options.owner}/${REVIEW_TEAM_SLUG}: ${decisions === 1 ? "one choice needs" : `${decisions} choices need`} a decision. Approve to keep them. To reverse one, push the change to \`${syncBranchName(plan)}\` and reply here with the decision; later syncs follow it.`
      : "No decisions needed. Approve once the required checks pass.",
  );
  return capped(lines.join("\n"));
}

function renderPullRequestBody(
  plan: ResolutionPlan,
  record: string,
  decisions: number,
  checkFails: boolean,
): string {
  const branch = syncBranchName(plan);
  return capped(
    [
      `<!-- sync-branches source=${plan.source} target=${plan.target} agent=true -->`,
      "",
      `Merging \`${plan.source}\` into \`${plan.target}\` conflicted, so Claude resolved it on \`${branch}\`. Every later push to \`${plan.source}\` updates this pull request instead of opening another one.`,
      "",
      decisions > 0
        ? `**${decisions} decision${decisions === 1 ? "" : "s"} need${decisions === 1 ? "s" : ""} review.**`
        : "**No decisions needed in the latest update.**",
      ...(checkFails ? ["", "**The quality checks still fail on this branch.**"] : []),
      "",
      "Approve to fast-forward `" +
        plan.target +
        "`; do not use the merge button. To change a resolution, push to `" +
        branch +
        "` and explain the decision in a comment: later syncs read this pull request and reuse the decision. Converting this pull request to a draft pauses updates until it is marked ready again.",
      "",
      "Earlier resolution comments on this pull request still apply. Latest:",
      "",
      record.replace(RESOLUTION_MARKER, "").trim(),
    ].join("\n"),
  );
}

function renderManualComment(
  plan: ResolutionPlan,
  result: Extract<ResolveResult, { status: "manual" }>,
): string {
  const branch = syncBranchName(plan);
  return [
    `Merging \`${result.ref}\` (\`${short(result.sha)}\`) into \`${branch}\` needs a maintainer. ${neutralize(result.reason)}`,
    "",
    "Conflicting files:",
    "",
    ...result.files.map((file) => `- ${pathCode(file)}`),
    "",
    "This pull request is now a draft, so syncs pause. To resolve:",
    "",
    "```sh",
    "git fetch origin",
    `git switch ${branch}`,
    ...plan.merges.map(
      ({ ref }) => `git merge origin/${ref}  # resolve any conflicts, then commit`,
    ),
    `git push origin ${branch}`,
    "```",
    "",
    "Then mark it ready for review; later syncs resume updating it.",
  ].join("\n");
}

function pushSyncBranch(git: GitRunner, plan: ResolutionPlan, sha: string): void {
  const branch = syncBranchName(plan);
  gitOrThrow(git, [
    "push",
    `--force-with-lease=refs/heads/${branch}:${plan.expectedSyncHead ?? ""}`,
    "origin",
    `${sha}:refs/heads/${branch}`,
  ]);
}

export async function publishResolution(
  io: PublishIo,
  plan: ResolutionPlan,
  result: ResolveResult,
  options: PublishOptions,
): Promise<PublishOutcome> {
  const { git } = io;
  const branch = syncBranchName(plan);

  if (result.status === "manual") {
    if (plan.pullRequest !== null) {
      await io.comment(plan.pullRequest, renderManualComment(plan, result));
      await io.convertToDraft(plan.pullRequest);
      return { status: "needs-maintainer", pullRequest: plan.pullRequest };
    }
    pushSyncBranch(git, plan, result.sha);
    const { title, body } = renderConflictPr(
      plan,
      result.files,
      result.sha,
      plan.base,
      `Claude did not resolve this merge: ${neutralize(result.reason)}`,
    );
    const pullRequest = await io.createPullRequest({
      base: plan.target,
      head: branch,
      title,
      body,
      labels: ["do not merge"],
    });
    return { status: "needs-maintainer", pullRequest };
  }

  gitOrThrow(git, ["fetch", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  gitOrThrow(git, ["fetch", options.bundlePath, "+refs/sync/resolved:refs/sync/resolved"]);
  const head = gitOrThrow(git, ["rev-parse", "refs/sync/resolved"]);
  if (head !== result.head) {
    return {
      status: "rejected",
      reason: `The bundle head ${short(head)} is not ${short(result.head)}.`,
    };
  }
  const validation = validateResolvedHistory(git, plan, head);
  if ("error" in validation) {
    return { status: "rejected", reason: validation.error };
  }
  const reviewed = withProtectedDecisions(
    result,
    validation.protectedConflicts,
    validation.protectedEdits,
  );

  pushSyncBranch(git, plan, head);
  const record = renderResolutionRecord(plan, reviewed, options);
  const decisions = decisionCount(reviewed);
  const body = renderPullRequestBody(plan, record, decisions, reviewed.check?.passed === false);
  let pullRequest = plan.pullRequest;
  if (pullRequest === null) {
    pullRequest = await io.createPullRequest({
      base: plan.target,
      head: branch,
      title: `chore(repo): sync ${plan.source} into ${plan.target}`,
      body,
      labels: ["do not merge"],
    });
  } else {
    await io.updatePullRequestBody(pullRequest, body);
  }
  await io.comment(pullRequest, record);
  if (decisions > 0) {
    try {
      await io.requestTeamReview(pullRequest, REVIEW_TEAM_SLUG);
    } catch (error) {
      console.log(`::warning::Could not request review from ${REVIEW_TEAM_SLUG}: ${error}`);
    }
  }
  try {
    await io.dispatchAiReview(pullRequest);
  } catch (error) {
    console.log(`::warning::Could not start the AI review: ${error}`);
  }
  return { status: "published", pullRequest, decisions };
}

export type RepairPublishOutcome =
  | { status: "rejected"; reason: string }
  | { status: "superseded" }
  | { status: "published"; head: string; decisions: number };

export function renderRepairRecord(
  plan: RepairPlan,
  result: RepairResult,
  decisions: AgentDecision[],
  unanswered: number,
  options: Pick<PublishOptions, "model" | "owner" | "runUrl">,
): string {
  const moved = result.head !== plan.head;
  const lines = [
    `${REPAIR_RESULT_MARKER} round=${plan.round} head=${plan.head} -->`,
    `### Repair round ${plan.round} for \`${short(result.head)}\``,
    "",
    `Claude (\`${options.model}\`) worked on ${plan.failures.length} failing CI job${plan.failures.length === 1 ? "" : "s"} and ${plan.findings.length} AI review finding${plan.findings.length === 1 ? "" : "s"}. [Workflow run](${options.runUrl})`,
  ];
  if (plan.failures.length > 0) {
    lines.push("", "**Failing jobs**", "", ...plan.failures.map(({ name }) => `- ${name}`));
  }
  if (result.outcome) {
    lines.push("", neutralize(result.outcome.summary));
  }
  if (result.failure) {
    lines.push("", `**No repair pushed.** ${neutralize(result.failure)}`);
  } else if (!moved) {
    lines.push("", "No file changes were needed.");
  }
  if (result.outcome && result.outcome.files.length > 0) {
    lines.push(
      "",
      "**Changed files**",
      "",
      ...result.outcome.files.map(
        ({ path, resolution }) => `- ${pathCode(path)}: ${neutralize(resolution)}`,
      ),
    );
  }
  if (plan.findings.length > 0) {
    lines.push(
      "",
      unanswered === 0
        ? "Replied on every AI review finding; fixed ones are resolved, declined ones stay open for you to judge."
        : `${unanswered} AI review finding${unanswered === 1 ? " was" : "s were"} not addressed and stay${unanswered === 1 ? "s" : ""} open for a maintainer.`,
    );
  }
  lines.push(...renderDecisions(decisions));
  if (result.check) {
    lines.push("", ...renderCheck(result.check));
  }
  if (decisions.length > 0) {
    lines.push(
      "",
      `@${options.owner}/${REVIEW_TEAM_SLUG}: ${decisions.length === 1 ? "one choice needs" : `${decisions.length} choices need`} a decision.`,
    );
  }
  return capped(lines.join("\n"));
}

/**
 * Publishes one repair round: pushes its commits when the branch has not moved, replies on every planned review
 * finding, resolves the threads it fixed, and records the round. A branch that moved means a newer sync or round
 * owns it, so the round is dropped.
 */
export async function publishRepair(
  io: RepairIo,
  plan: RepairPlan,
  result: RepairResult,
  options: PublishOptions,
): Promise<RepairPublishOutcome> {
  const { git } = io;
  const branch = `sync/${plan.source}-into-${plan.target}`;
  const moved = result.head !== plan.head;
  let protectedEdits: string[] = [];
  if (moved) {
    gitOrThrow(git, ["fetch", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
    gitOrThrow(git, ["fetch", options.bundlePath, "+refs/sync/resolved:refs/sync/resolved"]);
    const head = gitOrThrow(git, ["rev-parse", "refs/sync/resolved"]);
    if (head !== result.head) {
      return {
        status: "rejected",
        reason: `The bundle head ${short(head)} is not ${short(result.head)}.`,
      };
    }
    const validation = validateFollowUps(git, plan.head, head);
    if ("error" in validation) {
      return { status: "rejected", reason: validation.error };
    }
    protectedEdits = validation.protectedEdits;
    const push = git([
      "push",
      `--force-with-lease=refs/heads/${branch}:${plan.head}`,
      "origin",
      `${head}:refs/heads/${branch}`,
    ]);
    if (push.status !== 0) {
      const remote = gitOrThrow(git, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
      if (remote.split("\t")[0] === plan.head) {
        throw new Error(`git push to ${branch} failed: ${push.stderr}`);
      }
      return { status: "superseded" };
    }
  } else {
    const remote = gitOrThrow(git, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    if (remote.split("\t")[0] !== plan.head) {
      return { status: "superseded" };
    }
  }

  // Findings left unanswered stay open, so the settle step hands them to a maintainer instead of treating them as done.
  const replies = new Map(result.outcome?.findings.map((reply) => [reply.commentId, reply]));
  let answered = 0;
  for (const finding of plan.findings) {
    const reply = replies.get(finding.commentId);
    const fixed = reply?.disposition === "fixed";
    if (!reply || (fixed && !moved)) {
      continue;
    }
    answered += 1;
    await io.replyToReviewComment(
      plan.pullRequest,
      finding.commentId,
      `${fixed ? "Fixed" : "Declined"} in repair round ${plan.round}: ${neutralize(reply.reply)}`,
    );
    if (fixed) {
      await io.resolveReviewThread(finding.threadId);
    }
  }

  const agentDecisions = [...(result.outcome?.decisions ?? []), ...(result.check?.decisions ?? [])];
  const decisions = [
    ...agentDecisions,
    ...protectedDecisions(protectedEdits, agentDecisions, EDIT_QUESTION),
  ];
  await io.comment(
    plan.pullRequest,
    renderRepairRecord(plan, result, decisions, plan.findings.length - answered, options),
  );
  if (decisions.length > 0) {
    try {
      await io.requestTeamReview(plan.pullRequest, REVIEW_TEAM_SLUG);
    } catch (error) {
      console.log(`::warning::Could not request review from ${REVIEW_TEAM_SLUG}: ${error}`);
    }
  }
  return { status: "published", head: result.head, decisions: decisions.length };
}

function makeIo(token: string, repository: string): PublishIo & RepairIo {
  const pulls = `/repos/${repository}/pulls`;
  return {
    git: makeGit(process.cwd()),
    async createPullRequest({ labels, ...draft }) {
      const created = await githubRequest<{ number: number }>(token, pulls, draft);
      await githubRequest(token, `/repos/${repository}/issues/${created.number}/labels`, {
        labels,
      });
      return created.number;
    },
    async updatePullRequestBody(pullRequest, body) {
      await githubRequest(token, `${pulls}/${pullRequest}`, { body }, "PATCH");
    },
    async convertToDraft(pullRequest) {
      const { node_id: id } = await githubRequest<{ node_id: string }>(
        token,
        `${pulls}/${pullRequest}`,
      );
      await githubGraphql(
        token,
        "mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }",
        { id },
      );
    },
    async comment(pullRequest, body) {
      await githubRequest(token, `/repos/${repository}/issues/${pullRequest}/comments`, { body });
    },
    async requestTeamReview(pullRequest, team) {
      await githubRequest(token, `${pulls}/${pullRequest}/requested_reviewers`, {
        team_reviewers: [team],
      });
    },
    async dispatchAiReview(pullRequest) {
      await githubRequest(
        requireEnv("AI_REVIEW_TOKEN"),
        `/repos/${repository}/actions/workflows/ai-review.yml/dispatches`,
        { ref: requireEnv("DEFAULT_BRANCH"), inputs: { pr: String(pullRequest) } },
      );
    },
    async replyToReviewComment(pullRequest, commentId, body) {
      await githubRequest(token, `${pulls}/${pullRequest}/comments/${commentId}/replies`, { body });
    },
    async resolveReviewThread(threadId) {
      await githubGraphql(
        token,
        "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }",
        { id: threadId },
      );
    },
  };
}

async function main(): Promise<void> {
  const resultDir = resolve(requireEnv("RESULT_DIR"));
  const repository = requireEnv("REPOSITORY");
  const io = makeIo(requireEnv("GH_TOKEN"), repository);
  const options = {
    bundlePath: join(resultDir, "resolved.bundle"),
    model: requireEnv("CLAUDE_MODEL"),
    owner: repository.split("/")[0] ?? "",
    runUrl: requireEnv("RUN_URL"),
  };
  const read = <T>(): T => JSON.parse(readFileSync(join(resultDir, "result.json"), "utf8")) as T;

  if (process.argv[2] === "repair") {
    const plan = JSON.parse(requireEnv("REPAIR")) as RepairPlan;
    const outcome = await publishRepair(io, plan, read<RepairResult>(), options);
    switch (outcome.status) {
      case "rejected":
        console.error(`::error::Refusing to publish the repair: ${outcome.reason}`);
        process.exit(1);
        break;
      case "superseded":
        console.log("::notice::The sync branch moved during the repair; a later round takes over.");
        break;
      case "published":
        console.log(`Repair round ${plan.round} published; head ${outcome.head}.`);
        break;
    }
    return;
  }

  const plan = JSON.parse(requireEnv("PLAN")) as ResolutionPlan;
  const outcome = await publishResolution(io, plan, read<ResolveResult>(), options);
  switch (outcome.status) {
    case "rejected":
      console.error(`::error::Refusing to publish the resolution: ${outcome.reason}`);
      process.exit(1);
      break;
    case "published":
      console.log(
        `Updated PR #${outcome.pullRequest}; ${outcome.decisions} decision(s) need review.`,
      );
      break;
    case "needs-maintainer":
      console.log(`::warning::PR #${outcome.pullRequest} needs a maintainer to resolve the merge.`);
      break;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
