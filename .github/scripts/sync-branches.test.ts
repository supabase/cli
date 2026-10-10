import { afterEach, describe, expect, test } from "bun:test";

import { git, createTestRepo, type TestRepo } from "./promotion-test-repo.ts";
import { isAllowedSyncPair, makeGit } from "./promotion-shared.ts";
import {
  parsePair,
  renderConflictPr,
  syncBranches,
  syncBranchName,
  type OpenPullRequest,
  type PullRequestDraft,
  type SyncIo,
} from "./sync-branches.ts";

const repos: TestRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.cleanup();
  }
});

function setup(): TestRepo {
  const repo = createTestRepo();
  repos.push(repo);
  return repo;
}

function branchFromMain(repo: TestRepo, name: string): void {
  git(repo.seed, "switch", "-c", name, "main");
  git(repo.seed, "push", "origin", name);
}

function fakeIo(checkout: string, openPullRequest?: OpenPullRequest) {
  const created: PullRequestDraft[] = [];
  const io: SyncIo = {
    git: makeGit(checkout),
    findOpenPullRequest: async () => openPullRequest,
    createPullRequest: async (draft) => {
      created.push(draft);
      return 99;
    },
  };
  return { io, created };
}

const pair = parsePair("main-into-develop");

describe("parsePair", () => {
  test("splits source and target", () => {
    expect(parsePair("develop-into-next")).toEqual({ source: "develop", target: "next" });
    expect(syncBranchName(parsePair("develop-into-next"))).toBe("sync/develop-into-next");
  });

  test.each(["develop", "-into-next", "develop-into-", "a b-into-c"])("rejects %p", (value) => {
    expect(() => parsePair(value)).toThrow("Invalid sync pair");
  });
});

describe("isAllowedSyncPair", () => {
  test.each([
    ["main", "develop", true],
    ["develop", "next", true],
    ["develop", "main", false],
    ["next", "develop", false],
    ["main", "next", false],
    ["foo", "main", false],
    ["main", "v2.x", false],
  ])("%s into %s is %p", (source, target, allowed) => {
    expect(isAllowedSyncPair(source, target)).toBe(allowed);
  });
});

describe("renderConflictPr", () => {
  test("lists conflicting files behind a stable marker", () => {
    const { title, body } = renderConflictPr(
      pair,
      ["a.txt", "dir/b.txt"],
      "a".repeat(40),
      "b".repeat(40),
    );
    expect(title).toBe("chore(repo): sync main into develop");
    expect(body).toStartWith(
      `<!-- sync-branches source=main target=develop source-sha=${"a".repeat(40)} target-sha=${"b".repeat(40)} -->`,
    );
    expect(body).toContain("- `a.txt`\n- `dir/b.txt`");
    expect(body).toContain("git merge origin/develop");
    expect(body).toContain("Approve to fast-forward `develop`; do not use the merge button.");
  });
});

describe("syncBranches", () => {
  test("skips when the target branch does not exist", async () => {
    const repo = setup();
    const checkout = repo.checkout();
    const { io, created } = fakeIo(checkout);

    const outcome = await syncBranches(io, parsePair("develop-into-next"));

    expect(outcome).toEqual({ status: "skipped-missing-branch", branch: "next" });
    expect(created).toHaveLength(0);
  });

  test("skips when the source branch does not exist", async () => {
    const repo = setup();
    branchFromMain(repo, "develop");
    const { io } = fakeIo(repo.checkout());

    const outcome = await syncBranches(io, parsePair("next-into-develop"));

    expect(outcome).toEqual({ status: "skipped-missing-branch", branch: "next" });
  });

  test("skips while a sync pull request is open", async () => {
    const repo = setup();
    branchFromMain(repo, "develop");
    git(repo.seed, "switch", "main");
    repo.commit(repo.seed, "main.txt", "main\n", "fix: main");
    git(repo.seed, "push", "origin", "main");
    const developBefore = repo.remoteTip("develop");
    const { io } = fakeIo(repo.checkout(), { number: 12, draft: false });

    const outcome = await syncBranches(io, pair);

    expect(outcome).toEqual({ status: "skipped-open-pr", pullRequest: 12 });
    expect(repo.remoteTip("develop")).toBe(developBefore);
  });

  test("reports up-to-date when the target already contains the source", async () => {
    const repo = setup();
    branchFromMain(repo, "develop");
    repo.commit(repo.seed, "develop.txt", "develop\n", "feat: develop");
    git(repo.seed, "push", "origin", "develop");
    const developBefore = repo.remoteTip("develop");
    const { io } = fakeIo(repo.checkout());

    expect(await syncBranches(io, pair)).toEqual({ status: "up-to-date" });
    expect(repo.remoteTip("develop")).toBe(developBefore);
  });

  test("merges cleanly onto the target tip", async () => {
    const repo = setup();
    branchFromMain(repo, "develop");
    repo.commit(repo.seed, "develop.txt", "develop\n", "feat: develop");
    git(repo.seed, "push", "origin", "develop");
    const developBefore = repo.remoteTip("develop");
    git(repo.seed, "switch", "main");
    const mainTip = repo.commit(repo.seed, "main.txt", "main\n", "fix: hotfix");
    git(repo.seed, "push", "origin", "main");
    const { io, created } = fakeIo(repo.checkout());

    expect(await syncBranches(io, pair)).toEqual({ status: "merged" });

    const developTip = repo.remoteTip("develop");
    expect(git(repo.remote, "rev-parse", `${developTip}^1`)).toBe(developBefore);
    expect(git(repo.remote, "rev-parse", `${developTip}^2`)).toBe(mainTip);
    expect(created).toHaveLength(0);
  });

  test("opens a conflict pull request from the source tip and leaves the target alone", async () => {
    const repo = setup();
    branchFromMain(repo, "develop");
    repo.commit(repo.seed, "shared.txt", "develop\n", "feat: develop edit");
    git(repo.seed, "push", "origin", "develop");
    const developBefore = repo.remoteTip("develop");
    git(repo.seed, "switch", "main");
    const mainTip = repo.commit(repo.seed, "shared.txt", "main\n", "fix: main edit");
    git(repo.seed, "push", "origin", "main");
    const { io, created } = fakeIo(repo.checkout());

    const outcome = await syncBranches(io, pair);

    expect(outcome).toEqual({
      status: "conflict-pr-opened",
      pullRequest: 99,
      files: ["shared.txt"],
    });
    expect(repo.remoteTip("sync/main-into-develop")).toBe(mainTip);
    expect(repo.remoteTip("develop")).toBe(developBefore);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      base: "develop",
      head: "sync/main-into-develop",
      title: "chore(repo): sync main into develop",
      labels: ["do not merge"],
    });
    expect(created[0]?.body).toContain("- `shared.txt`");
  });

  test("replaces a stale sync branch when its pull request is closed", async () => {
    const repo = setup();
    branchFromMain(repo, "develop");
    repo.commit(repo.seed, "shared.txt", "develop\n", "feat: develop edit");
    git(repo.seed, "push", "origin", "develop");
    git(repo.seed, "switch", "main");
    repo.commit(repo.seed, "shared.txt", "stale\n", "fix: stale");
    git(repo.seed, "push", "origin", "main:refs/heads/sync/main-into-develop");
    const mainTip = repo.commit(repo.seed, "shared.txt", "main\n", "fix: main edit");
    git(repo.seed, "push", "origin", "main");
    const { io } = fakeIo(repo.checkout());

    await syncBranches(io, pair);

    expect(repo.remoteTip("sync/main-into-develop")).toBe(mainTip);
  });

  test("retries when the target advances between fetch and push", async () => {
    const repo = setup();
    branchFromMain(repo, "develop");
    repo.commit(repo.seed, "develop.txt", "develop\n", "feat: develop");
    git(repo.seed, "push", "origin", "develop");
    git(repo.seed, "switch", "main");
    const mainTip = repo.commit(repo.seed, "main.txt", "main\n", "fix: hotfix");
    git(repo.seed, "push", "origin", "main");
    const { io } = fakeIo(repo.checkout());

    let raced = false;
    const racing: SyncIo = {
      ...io,
      git(args) {
        const result = io.git(args);
        if (!raced && args[0] === "fetch") {
          raced = true;
          git(repo.seed, "switch", "develop");
          repo.commit(repo.seed, "late.txt", "late\n", "feat: late");
          git(repo.seed, "push", "origin", "develop");
        }
        return result;
      },
    };

    expect(await syncBranches(racing, pair)).toEqual({ status: "merged" });

    const developTip = repo.remoteTip("develop");
    expect(repo.isAncestor(mainTip, developTip)).toBe(true);
    expect(git(repo.remote, "show", `${developTip}^1:late.txt`)).toBe("late");
  });
});

describe("syncBranches with agent resolution", () => {
  const nextPair = parsePair("develop-into-next");

  /** `develop` and `next` both edit shared.txt; returns their tips. */
  function divergedBranches(repo: TestRepo): { develop: string; next: string } {
    branchFromMain(repo, "next");
    const next = repo.commit(repo.seed, "shared.txt", "next\n", "feat!: next edit");
    git(repo.seed, "push", "origin", "next");
    branchFromMain(repo, "develop");
    const develop = repo.commit(repo.seed, "shared.txt", "develop\n", "fix: develop edit");
    git(repo.seed, "push", "origin", "develop");
    return { develop, next };
  }

  /** Pushes a resolved merge of `develop` into `next` as the sync branch head. */
  function resolvedSyncBranch(repo: TestRepo, tips: { develop: string; next: string }): string {
    git(repo.seed, "switch", "--detach", tips.next);
    git(repo.seed, "merge", "-s", "ours", "--no-commit", tips.develop);
    return resolvedMerge(repo);
  }

  function resolvedMerge(repo: TestRepo): string {
    repo.commit(repo.seed, "shared.txt", "resolved\n", "Merge develop into sync/develop-into-next");
    git(repo.seed, "push", "--force", "origin", "HEAD:refs/heads/sync/develop-into-next");
    return git(repo.seed, "rev-parse", "HEAD");
  }

  test("hands a conflict to the agent instead of opening a pull request", async () => {
    const repo = setup();
    const tips = divergedBranches(repo);
    const { io, created } = fakeIo(repo.checkout());

    const outcome = await syncBranches(io, nextPair);

    expect(outcome).toEqual({
      status: "needs-resolution",
      plan: {
        source: "develop",
        target: "next",
        base: tips.next,
        merges: [{ ref: "develop", sha: tips.develop }],
        expectedSyncHead: null,
        pullRequest: null,
      },
    });
    expect(created).toHaveLength(0);
    expect(repo.remoteTip("next")).toBe(tips.next);
  });

  test("merges a clean develop push into the open sync pull request, not into next", async () => {
    const repo = setup();
    const tips = divergedBranches(repo);
    const syncHead = resolvedSyncBranch(repo, tips);
    git(repo.seed, "switch", "develop");
    const developTip = repo.commit(repo.seed, "other.txt", "other\n", "feat: unrelated");
    git(repo.seed, "push", "origin", "develop");
    const { io, created } = fakeIo(repo.checkout(), { number: 7, draft: false });

    expect(await syncBranches(io, nextPair)).toEqual({ status: "pr-updated", pullRequest: 7 });

    const updated = repo.remoteTip("sync/develop-into-next");
    expect(git(repo.remote, "rev-parse", `${updated}^1`)).toBe(syncHead);
    expect(git(repo.remote, "rev-parse", `${updated}^2`)).toBe(developTip);
    expect(git(repo.remote, "show", `${updated}:shared.txt`)).toBe("resolved");
    expect(repo.remoteTip("next")).toBe(tips.next);
    expect(created).toHaveLength(0);
  });

  test("hands a develop push that conflicts with the open resolution to the agent", async () => {
    const repo = setup();
    const tips = divergedBranches(repo);
    const syncHead = resolvedSyncBranch(repo, tips);
    git(repo.seed, "switch", "develop");
    const developTip = repo.commit(repo.seed, "shared.txt", "develop again\n", "fix: again");
    git(repo.seed, "push", "origin", "develop");
    const { io } = fakeIo(repo.checkout(), { number: 7, draft: false });

    const outcome = await syncBranches(io, nextPair);

    expect(outcome).toEqual({
      status: "needs-resolution",
      plan: {
        source: "develop",
        target: "next",
        base: syncHead,
        merges: [{ ref: "develop", sha: developTip }],
        expectedSyncHead: syncHead,
        pullRequest: 7,
      },
    });
    expect(repo.remoteTip("sync/develop-into-next")).toBe(syncHead);
  });

  test.each([
    ["is a draft", true, true],
    ["still points at a develop commit", false, false],
  ])("waits for a person while the open pull request %s", async (_, draft, resolved) => {
    const repo = setup();
    const tips = divergedBranches(repo);
    if (resolved) {
      resolvedSyncBranch(repo, tips);
    } else {
      git(repo.seed, "push", "origin", `${tips.develop}:refs/heads/sync/develop-into-next`);
    }
    const syncHead = repo.remoteTip("sync/develop-into-next");
    git(repo.seed, "switch", "develop");
    repo.commit(repo.seed, "other.txt", "other\n", "feat: unrelated");
    git(repo.seed, "push", "origin", "develop");
    const { io } = fakeIo(repo.checkout(), { number: 7, draft });

    expect(await syncBranches(io, nextPair)).toEqual({ status: "skipped-open-pr", pullRequest: 7 });
    expect(repo.remoteTip("sync/develop-into-next")).toBe(syncHead);
  });
});
