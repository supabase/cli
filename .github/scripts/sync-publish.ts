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
import {
  type AgentResolution,
  type CheckResult,
  RESOLUTION_MARKER,
  type ResolveResult,
} from "./sync-resolve.ts";

/** Team asked to review resolutions that need a decision. */
export const REVIEW_TEAM_SLUG = "cli";

const MAX_BODY_LENGTH = 60_000;

export interface PublishIo {
  git: GitRunner;
  createPullRequest(draft: PullRequestDraft): Promise<number>;
  updatePullRequestBody(pullRequest: number, body: string): Promise<void>;
  convertToDraft(pullRequest: number): Promise<void>;
  comment(pullRequest: number, body: string): Promise<void>;
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

/** Agent text is rendered into comments; this keeps it from pinging anyone or overflowing the body limit. */
function neutralize(text: string): string {
  return text.replace(/@(?=[\w-])/g, "@​");
}

function capped(body: string): string {
  return body.length <= MAX_BODY_LENGTH
    ? body
    : `${body.slice(0, MAX_BODY_LENGTH)}\n\n… truncated; see the workflow run.`;
}

/**
 * Checks that `head` is exactly the plan's merges on top of its base, changing protected paths only where they
 * conflicted. Returns those conflicted protected paths per merge, in plan order.
 */
export function validateResolvedHistory(
  git: GitRunner,
  plan: ResolutionPlan,
  head: string,
): { error: string } | { protectedConflicts: string[][] } {
  const protectedConflicts: string[][] = [];
  let commit = head;
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
    ? { protectedConflicts }
    : { error: `The history does not start at \`${short(plan.base)}\`.` };
}

/** Adds a decision for every conflicted protected path the agent did not already raise, whatever it reported. */
export function withProtectedDecisions(
  result: Extract<ResolveResult, { status: "resolved" }>,
  protectedConflicts: string[][],
): Extract<ResolveResult, { status: "resolved" }> {
  return {
    ...result,
    merges: result.merges.map((merge, index) => {
      const raised = new Set(merge.resolution?.decisions.flatMap(({ paths }) => paths));
      const missing = (protectedConflicts[index] ?? []).filter((path) => !raised.has(path));
      if (merge.resolution === null || missing.length === 0) {
        return merge;
      }
      return {
        ...merge,
        resolution: {
          ...merge.resolution,
          decisions: [
            ...merge.resolution.decisions,
            ...missing.map((path) => ({
              paths: [path],
              question:
                "This workflow file conflicted and runs with repository secrets. Is the resolution right?",
              chosen: "The resolution on this branch.",
              alternative: "Resolve it by hand on the sync branch.",
            })),
          ],
        },
      };
    }),
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
      `${index + 1}. ${neutralize(decision.question)} (${decision.paths.map((path) => `\`${path}\``).join(", ")})`,
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
    lines.push(`- \`${file.path}\`: ${neutralize(file.resolution)}${precedent}`);
  }
  for (const path of resolution.deletedFiles) {
    lines.push(`- \`${path}\`: deleted`);
  }
  return lines;
}

function renderCheck(check: CheckResult): string[] {
  const fixes = check.fixes.map(
    ({ path, resolution }) => `- \`${path}\`: ${neutralize(resolution)}`,
  );
  const decisions = renderDecisions(check.decisions);
  if (check.passed) {
    return fixes.length === 0
      ? ["#### Format and type check", "", "Passed on the merged tree."]
      : [
          "#### Format and type check",
          "",
          "Passed after these changes to the merged tree:",
          "",
          ...fixes,
          ...decisions,
        ];
  }
  return [
    "#### Format and type check",
    "",
    "**The type check still fails.** Fix it on the branch before approving.",
    ...(fixes.length > 0 ? ["", "Already changed:", "", ...fixes] : []),
    ...decisions,
    "",
    "<details><summary>Type checker output</summary>",
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
      ...(checkFails ? ["", "**The type check still fails on this branch.**"] : []),
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
    `Merging \`${result.ref}\` (\`${short(result.sha)}\`) into \`${branch}\` needs a maintainer. ${result.reason}`,
    "",
    "Conflicting files:",
    "",
    ...result.files.map((file) => `- \`${file}\``),
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
  const reviewed = withProtectedDecisions(result, validation.protectedConflicts);

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
  return { status: "published", pullRequest, decisions };
}

function makeIo(token: string, repository: string): PublishIo {
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
  };
}

async function main(): Promise<void> {
  const plan = JSON.parse(requireEnv("PLAN")) as ResolutionPlan;
  const resultDir = resolve(requireEnv("RESULT_DIR"));
  const repository = requireEnv("REPOSITORY");
  const result = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf8")) as ResolveResult;
  const outcome = await publishResolution(
    makeIo(requireEnv("GH_TOKEN"), repository),
    plan,
    result,
    {
      bundlePath: join(resultDir, "resolved.bundle"),
      model: requireEnv("CLAUDE_MODEL"),
      owner: repository.split("/")[0] ?? "",
      runUrl: requireEnv("RUN_URL"),
    },
  );
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
