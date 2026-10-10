import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeGit } from "./promotion-shared.ts";
import { createTestRepo, git, type TestRepo } from "./promotion-test-repo.ts";
import type { PullRequestDraft, ResolutionPlan } from "./sync-branches.ts";
import { type PublishIo, type RepairIo, publishRepair, publishResolution } from "./sync-publish.ts";
import type { RepairPlan } from "./sync-repair.ts";
import { type AgentResolution, type ResolveResult, replayMerges } from "./sync-resolve.ts";

const repos: TestRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.cleanup();
  }
});

const decision = {
  paths: ["shared.txt"],
  question: "Which default wins?",
  chosen: "next's default, @someone",
  alternative: "develop's default",
};

/** `next` and `develop` both edit shared.txt, and also `.github/ci.yml` when `workflowConflict`. */
function diverged(workflowConflict = false): { repo: TestRepo; plan: ResolutionPlan } {
  const repo = createTestRepo();
  repos.push(repo);
  mkdirSync(join(repo.seed, ".github"), { recursive: true });
  repo.commit(repo.seed, ".github/ci.yml", "base\n", "ci: base");
  git(repo.seed, "push", "origin", "main");
  const tips: Record<string, string> = {};
  for (const branch of ["next", "develop"]) {
    git(repo.seed, "switch", "-c", branch, "main");
    if (workflowConflict) {
      repo.commit(repo.seed, ".github/ci.yml", `${branch}\n`, `ci: ${branch}`);
    }
    tips[branch] = repo.commit(repo.seed, "shared.txt", `${branch}\n`, `feat: ${branch}`);
    git(repo.seed, "push", "origin", branch);
  }
  return {
    repo,
    plan: {
      source: "develop",
      target: "next",
      base: tips.next ?? "",
      merges: [{ ref: "develop", sha: tips.develop ?? "" }],
      expectedSyncHead: null,
      pullRequest: null,
    },
  };
}

/** Runs the resolve step the way the workflow does and returns its result and bundle. */
async function resolveWith(
  repo: TestRepo,
  plan: ResolutionPlan,
  edit: (checkout: string) => void,
  agent: Partial<AgentResolution> = {},
  followUp?: (checkout: string) => void,
): Promise<{ result: ResolveResult; bundlePath: string }> {
  const checkout = repo.checkout();
  const git_ = makeGit(checkout);
  let result = await replayMerges(git_, checkout, plan, async () => {
    edit(checkout);
    return {
      status: "resolved",
      summary: "Combined both sides.",
      files: [{ path: "shared.txt", resolution: "Kept both lines.", precedent: 3 }],
      deletedFiles: [],
      decisions: [],
      ...agent,
    };
  });
  if (followUp && result.status === "resolved") {
    followUp(checkout);
    result = { ...result, head: git(checkout, "rev-parse", "HEAD") };
  }
  const bundlePath = join(mkdtempSync(join(tmpdir(), "sync-bundle-")), "resolved.bundle");
  if (result.status === "resolved") {
    git(checkout, "update-ref", "refs/sync/resolved", result.head);
    git(checkout, "bundle", "create", bundlePath, "refs/sync/resolved", `^${plan.base}`);
  }
  return { result, bundlePath };
}

function fakeIo(checkout: string) {
  const calls = {
    created: [] as PullRequestDraft[],
    updated: [] as { pullRequest: number; body: string }[],
    comments: [] as { pullRequest: number; body: string }[],
    drafts: [] as number[],
    reviews: [] as string[],
    aiReviews: [] as number[],
    replies: [] as { commentId: number; body: string }[],
    resolved: [] as string[],
  };
  const io: PublishIo & RepairIo = {
    git: makeGit(checkout),
    createPullRequest: async (draft) => {
      calls.created.push(draft);
      return 42;
    },
    updatePullRequestBody: async (pullRequest, body) => {
      calls.updated.push({ pullRequest, body });
    },
    convertToDraft: async (pullRequest) => {
      calls.drafts.push(pullRequest);
    },
    comment: async (pullRequest, body) => {
      calls.comments.push({ pullRequest, body });
    },
    requestTeamReview: async (_, team) => {
      calls.reviews.push(team);
    },
    dispatchAiReview: async (pullRequest) => {
      calls.aiReviews.push(pullRequest);
    },
    replyToReviewComment: async (_, commentId, body) => {
      calls.replies.push({ commentId, body });
    },
    resolveReviewThread: async (threadId) => {
      calls.resolved.push(threadId);
    },
  };
  return { io, calls };
}

const options = (bundlePath: string) => ({
  bundlePath,
  model: "claude-opus-5-5",
  owner: "supabase",
  runUrl: "https://example.test/run",
});

describe("publishResolution", () => {
  test("opens one sync pull request and asks the team about decisions", async () => {
    const { repo, plan } = diverged();
    const { result, bundlePath } = await resolveWith(
      repo,
      plan,
      (checkout) => writeFileSync(join(checkout, "shared.txt"), "next\ndevelop\n"),
      { decisions: [decision] },
    );
    const { io, calls } = fakeIo(repo.checkout());

    const outcome = await publishResolution(io, plan, result, options(bundlePath));

    expect(outcome).toEqual({ status: "published", pullRequest: 42, decisions: 1 });
    expect(repo.remoteTip("sync/develop-into-next")).toBe(
      result.status === "resolved" ? result.head : "",
    );
    expect(repo.remoteTip("next")).toBe(plan.base);
    expect(calls.created).toMatchObject([
      { base: "next", head: "sync/develop-into-next", labels: ["do not merge"] },
    ]);
    expect(calls.created[0]?.body).toContain("**1 decision needs review.**");
    const record = calls.comments[0]?.body ?? "";
    expect(record).toContain("1. Which default wins? (`shared.txt`)");
    expect(record).toContain("next's default, @​someone");
    expect(record).toContain("- `shared.txt`: Kept both lines. (follows #3)");
    expect(calls.reviews).toEqual(["cli"]);
    expect(calls.aiReviews).toEqual([42]);
  });

  test("updates the open pull request instead of opening another", async () => {
    const { repo, plan } = diverged();
    const openPlan = { ...plan, pullRequest: 9 };
    const { result, bundlePath } = await resolveWith(repo, openPlan, (checkout) =>
      writeFileSync(join(checkout, "shared.txt"), "next\ndevelop\n"),
    );
    const { io, calls } = fakeIo(repo.checkout());

    const outcome = await publishResolution(io, openPlan, result, options(bundlePath));

    expect(outcome).toEqual({ status: "published", pullRequest: 9, decisions: 0 });
    expect(calls.created).toHaveLength(0);
    expect(calls.updated.map(({ pullRequest }) => pullRequest)).toEqual([9]);
    expect(calls.comments[0]?.body).toContain("No decisions needed.");
    expect(calls.reviews).toHaveLength(0);
  });

  test("flags every conflicted workflow file for review even when the agent raises none", async () => {
    const { repo, plan } = diverged(true);
    const { result, bundlePath } = await resolveWith(repo, plan, (checkout) => {
      writeFileSync(join(checkout, "shared.txt"), "next\ndevelop\n");
      writeFileSync(join(checkout, ".github/ci.yml"), "next\ndevelop\n");
    });
    const { io, calls } = fakeIo(repo.checkout());

    const outcome = await publishResolution(io, plan, result, options(bundlePath));

    expect(outcome).toEqual({ status: "published", pullRequest: 42, decisions: 1 });
    expect(calls.comments[0]?.body).toContain(
      "1. This workflow file conflicted and runs with repository secrets. Is the resolution right? (`.github/ci.yml`)",
    );
    expect(calls.reviews).toEqual(["cli"]);
  });

  test("refuses a resolution that changes a workflow file without a conflict", async () => {
    const { repo, plan } = diverged();
    const checkout = repo.checkout();
    git(checkout, "switch", "--detach", plan.base);
    git(checkout, "merge", "-s", "ours", "--no-commit", plan.merges[0]?.sha ?? "");
    writeFileSync(join(checkout, ".github/ci.yml"), "tampered\n");
    git(checkout, "commit", "-am", "Merge develop");
    const head = git(checkout, "rev-parse", "HEAD");
    git(checkout, "update-ref", "refs/sync/resolved", head);
    const bundlePath = join(mkdtempSync(join(tmpdir(), "sync-bundle-")), "resolved.bundle");
    git(checkout, "bundle", "create", bundlePath, "refs/sync/resolved", `^${plan.base}`);
    const { io, calls } = fakeIo(repo.checkout());

    const outcome = await publishResolution(
      io,
      plan,
      {
        status: "resolved",
        head,
        merges: [{ ref: "develop", sha: plan.merges[0]?.sha ?? "", resolution: null }],
      },
      options(bundlePath),
    );

    expect(outcome).toEqual({
      status: "rejected",
      reason: `\`${head.slice(0, 7)}\` changes \`.github/ci.yml\` under \`.github/\` without a conflict.`,
    });
    expect(() => repo.remoteTip("sync/develop-into-next")).toThrow();
    expect(calls.comments).toHaveLength(0);
  });

  test("accepts a fix commit on a workflow file and asks for a decision on it", async () => {
    const { repo, plan } = diverged();
    const { result, bundlePath } = await resolveWith(
      repo,
      plan,
      (checkout) => writeFileSync(join(checkout, "shared.txt"), "next\ndevelop\n"),
      {},
      (checkout) => {
        writeFileSync(join(checkout, ".github/ci.yml"), "fixed\n");
        git(checkout, "commit", "-qam", "chore(repo): fix checks");
      },
    );
    const { io, calls } = fakeIo(repo.checkout());

    const outcome = await publishResolution(io, plan, result, options(bundlePath));

    expect(outcome).toEqual({ status: "published", pullRequest: 42, decisions: 1 });
    expect(calls.comments[0]?.body).toContain(
      "1. Claude changed this workflow file to fix the checks, and it runs with repository secrets. Is the change right? (`.github/ci.yml`)",
    );
  });

  test("pauses the open pull request as a draft when a maintainer must resolve", async () => {
    const { repo, plan } = diverged();
    const openPlan = {
      ...plan,
      merges: [{ ref: "next", sha: plan.base }, ...plan.merges],
      pullRequest: 9,
      expectedSyncHead: plan.base,
    };
    const { io, calls } = fakeIo(repo.checkout());

    const outcome = await publishResolution(
      io,
      openPlan,
      {
        status: "manual",
        reason: "The agent left the conflicts unresolved: the intent of both edits is unclear.",
        ref: "develop",
        sha: plan.merges[0]?.sha ?? "",
        files: ["shared.txt"],
      },
      options(""),
    );

    expect(outcome).toEqual({ status: "needs-maintainer", pullRequest: 9 });
    expect(calls.drafts).toEqual([9]);
    expect(calls.comments[0]?.body).toContain("git merge origin/next");
    expect(calls.comments[0]?.body).toContain("git merge origin/develop");
    expect(() => repo.remoteTip("sync/develop-into-next")).toThrow();
  });
});

describe("publishRepair", () => {
  /** Pushes the develop tip as the sync branch head and stacks a repair commit on it in a fresh checkout. */
  function repairedBranch(repo: TestRepo, plan: ResolutionPlan) {
    const head = plan.merges[0]?.sha ?? "";
    git(repo.seed, "push", "-q", "origin", `${head}:refs/heads/sync/develop-into-next`);
    const checkout = repo.checkout();
    git(checkout, "switch", "-q", "--detach", head);
    writeFileSync(join(checkout, ".github/ci.yml"), "restored input\n");
    git(checkout, "commit", "-qam", "chore(repo): address checks and review");
    const repaired = git(checkout, "rev-parse", "HEAD");
    git(checkout, "update-ref", "refs/sync/resolved", repaired);
    const bundlePath = join(mkdtempSync(join(tmpdir(), "sync-bundle-")), "resolved.bundle");
    git(checkout, "bundle", "create", bundlePath, "refs/sync/resolved", `^${head}`);
    const repairPlan: RepairPlan = {
      source: "develop",
      target: "next",
      pullRequest: 9,
      head,
      round: 1,
      failures: [{ name: "Check code quality", runId: 1, jobId: 2, conclusion: "failure" }],
      findings: [
        { threadId: "T1", commentId: 11, path: "shared.txt", line: 1, body: "Lost the input." },
        { threadId: "T2", commentId: 12, path: "shared.txt", line: 1, body: "Rename it." },
      ],
      reviewBody: null,
    };
    const result = {
      head: repaired,
      outcome: {
        status: "repaired" as const,
        summary: "Restored the setup input develop relies on.",
        files: [{ path: ".github/ci.yml", resolution: "Restored the input." }],
        findings: [
          { commentId: 11, disposition: "fixed" as const, reply: "Restored it, thanks @someone." },
          {
            commentId: 12,
            disposition: "declined" as const,
            reply: "Renaming is out of scope for a sync.",
          },
        ],
        decisions: [],
      },
    };
    return { repairPlan, result, bundlePath };
  }

  test("pushes the repair, answers every finding, and resolves only the fixed ones", async () => {
    const { repo, plan } = diverged();
    const { repairPlan, result, bundlePath } = repairedBranch(repo, plan);
    const { io, calls } = fakeIo(repo.checkout());

    const outcome = await publishRepair(io, repairPlan, result, options(bundlePath));

    expect(outcome).toEqual({ status: "published", head: result.head, decisions: 1 });
    expect(repo.remoteTip("sync/develop-into-next")).toBe(result.head);
    expect(calls.replies).toEqual([
      { commentId: 11, body: "Fixed in repair round 1: Restored it, thanks @\u200bsomeone." },
      { commentId: 12, body: "Declined in repair round 1: Renaming is out of scope for a sync." },
    ]);
    expect(calls.resolved).toEqual(["T1"]);
    const record = calls.comments[0]?.body ?? "";
    expect(record).toStartWith(`<!-- sync-repair round=1 head=${repairPlan.head} -->`);
    expect(record).toContain("(`.github/ci.yml`)");
    expect(calls.reviews).toEqual(["cli"]);
  });

  test("leaves findings open when the round produced no repair", async () => {
    const { repo, plan } = diverged();
    const { repairPlan, bundlePath } = repairedBranch(repo, plan);
    const { io, calls } = fakeIo(repo.checkout());

    const outcome = await publishRepair(
      io,
      repairPlan,
      { head: repairPlan.head, outcome: null, failure: "Claude timed out after 25 minutes." },
      options(bundlePath),
    );

    expect(outcome).toEqual({ status: "published", head: repairPlan.head, decisions: 0 });
    expect(calls.replies).toHaveLength(0);
    expect(calls.resolved).toHaveLength(0);
    expect(calls.comments[0]?.body).toContain("2 AI review findings were not addressed");
  });

  test.each([
    ["pushed a repair", false],
    ["changed nothing", true],
  ])("drops a round that %s when the sync branch moved meanwhile", async (_, unchanged) => {
    const { repo, plan } = diverged();
    const branch = repairedBranch(repo, plan);
    const { repairPlan, bundlePath } = branch;
    const result = unchanged ? { ...branch.result, head: repairPlan.head } : branch.result;
    git(repo.seed, "switch", "-q", "--detach", repairPlan.head);
    const newer = repo.commit(repo.seed, "late.txt", "late\n", "Merge develop again");
    git(repo.seed, "push", "-q", "--force", "origin", "HEAD:refs/heads/sync/develop-into-next");
    const { io, calls } = fakeIo(repo.checkout());

    const outcome = await publishRepair(io, repairPlan, result, options(bundlePath));

    expect(outcome).toEqual({ status: "superseded" });
    expect(repo.remoteTip("sync/develop-into-next")).toBe(newer);
    expect(calls.replies).toHaveLength(0);
    expect(calls.comments).toHaveLength(0);
  });
});
