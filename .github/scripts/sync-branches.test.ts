import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { git, createTestRepo, runEffect, type TestRepo } from "./promotion-test-repo.ts";
import { isAllowedSyncPair, makeGit } from "./promotion-shared.ts";
import {
  parsePair,
  renderConflictPr,
  syncBranches,
  syncBranchName,
  type PullRequestDraft,
  type SyncIo,
} from "./sync-branches.ts";

const repos: TestRepo[] = [];

afterEach(() =>
  runEffect(Effect.forEach(repos.splice(0), (repo) => repo.cleanup, { discard: true })),
);

function setup() {
  return Effect.gen(function* () {
    const repo = yield* createTestRepo;
    repos.push(repo);
    return repo;
  });
}

function branchFromMain(repo: TestRepo, name: string): void {
  git(repo.seed, "switch", "-c", name, "main");
  git(repo.seed, "push", "origin", name);
}

const repoRef = { full_name: "supabase/cli" };
const resyncable = {
  state: "open",
  head: { ref: "sync/develop-into-next", repo: repoRef as { full_name: string } | null },
  base: { ref: "next", repo: repoRef },
};

function fakeIo(checkout: string, openPullRequest?: number, pullRequest = resyncable) {
  const created: PullRequestDraft[] = [];
  const io: SyncIo = {
    git: makeGit(checkout),
    findOpenPullRequest: () => Promise.resolve(openPullRequest),
    createPullRequest: (draft) => {
      created.push(draft);
      return Promise.resolve(99);
    },
    getPullRequest: () => Promise.resolve(pullRequest),
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
  test("skips when the target branch does not exist", () =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* setup();
        const checkout = repo.checkout();
        const { io, created } = fakeIo(checkout);

        const outcome = yield* Effect.promise(() =>
          syncBranches(io, parsePair("develop-into-next")),
        );

        expect(outcome).toEqual({ status: "skipped-missing-branch", branch: "next" });
        expect(created).toHaveLength(0);
      }),
    ));

  test("skips when the source branch does not exist", () =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* setup();
        branchFromMain(repo, "develop");
        const { io } = fakeIo(repo.checkout());

        const outcome = yield* Effect.promise(() =>
          syncBranches(io, parsePair("next-into-develop")),
        );

        expect(outcome).toEqual({ status: "skipped-missing-branch", branch: "next" });
      }),
    ));

  test("skips while a sync pull request is open", () =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* setup();
        branchFromMain(repo, "develop");
        git(repo.seed, "switch", "main");
        yield* repo.commit(repo.seed, "main.txt", "main\n", "fix: main");
        git(repo.seed, "push", "origin", "main");
        const developBefore = repo.remoteTip("develop");
        const { io } = fakeIo(repo.checkout(), 12);

        const outcome = yield* Effect.promise(() => syncBranches(io, pair));

        expect(outcome).toEqual({ status: "skipped-open-pr", pullRequest: 12 });
        expect(repo.remoteTip("develop")).toBe(developBefore);
      }),
    ));

  test("reports up-to-date when the target already contains the source", () =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* setup();
        branchFromMain(repo, "develop");
        yield* repo.commit(repo.seed, "develop.txt", "develop\n", "feat: develop");
        git(repo.seed, "push", "origin", "develop");
        const developBefore = repo.remoteTip("develop");
        const { io } = fakeIo(repo.checkout());

        expect(yield* Effect.promise(() => syncBranches(io, pair))).toEqual({
          status: "up-to-date",
        });
        expect(repo.remoteTip("develop")).toBe(developBefore);
      }),
    ));

  test("merges cleanly onto the target tip", () =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* setup();
        branchFromMain(repo, "develop");
        yield* repo.commit(repo.seed, "develop.txt", "develop\n", "feat: develop");
        git(repo.seed, "push", "origin", "develop");
        const developBefore = repo.remoteTip("develop");
        git(repo.seed, "switch", "main");
        const mainTip = yield* repo.commit(repo.seed, "main.txt", "main\n", "fix: hotfix");
        git(repo.seed, "push", "origin", "main");
        const { io, created } = fakeIo(repo.checkout());

        expect(yield* Effect.promise(() => syncBranches(io, pair))).toEqual({ status: "merged" });

        const developTip = repo.remoteTip("develop");
        expect(git(repo.remote, "rev-parse", `${developTip}^1`)).toBe(developBefore);
        expect(git(repo.remote, "rev-parse", `${developTip}^2`)).toBe(mainTip);
        expect(created).toHaveLength(0);
      }),
    ));

  test("opens a conflict pull request from the source tip and leaves the target alone", () =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* setup();
        branchFromMain(repo, "develop");
        yield* repo.commit(repo.seed, "shared.txt", "develop\n", "feat: develop edit");
        git(repo.seed, "push", "origin", "develop");
        const developBefore = repo.remoteTip("develop");
        git(repo.seed, "switch", "main");
        const mainTip = yield* repo.commit(repo.seed, "shared.txt", "main\n", "fix: main edit");
        git(repo.seed, "push", "origin", "main");
        const { io, created } = fakeIo(repo.checkout());

        const outcome = yield* Effect.promise(() => syncBranches(io, pair));

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
      }),
    ));

  test("replaces a stale sync branch when its pull request is closed", () =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* setup();
        branchFromMain(repo, "develop");
        yield* repo.commit(repo.seed, "shared.txt", "develop\n", "feat: develop edit");
        git(repo.seed, "push", "origin", "develop");
        git(repo.seed, "switch", "main");
        yield* repo.commit(repo.seed, "shared.txt", "stale\n", "fix: stale");
        git(repo.seed, "push", "origin", "main:refs/heads/sync/main-into-develop");
        const mainTip = yield* repo.commit(repo.seed, "shared.txt", "main\n", "fix: main edit");
        git(repo.seed, "push", "origin", "main");
        const { io } = fakeIo(repo.checkout());

        yield* Effect.promise(() => syncBranches(io, pair));

        expect(repo.remoteTip("sync/main-into-develop")).toBe(mainTip);
      }),
    ));

  test("hands an open develop-into-next pull request back to the resolution without touching branches", () =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* setup();
        branchFromMain(repo, "next");
        branchFromMain(repo, "develop");
        yield* repo.commit(repo.seed, "develop.txt", "develop\n", "feat: develop");
        git(repo.seed, "push", "origin", "develop");
        const nextBefore = repo.remoteTip("next");
        const { io, created } = fakeIo(repo.checkout(), 31);

        const outcome = yield* Effect.promise(() =>
          syncBranches(io, parsePair("develop-into-next"), 31),
        );

        expect(outcome).toEqual({ status: "resync", pullRequest: 31 });
        expect(repo.remoteTip("next")).toBe(nextBefore);
        expect(() => repo.remoteTip("sync/develop-into-next")).toThrow();
        expect(created).toHaveLength(0);
      }),
    ));

  test.each([
    ["a closed pull request", "develop-into-next", { ...resyncable, state: "closed" }],
    [
      "another head",
      "develop-into-next",
      { ...resyncable, head: { ref: "feature", repo: repoRef } },
    ],
    [
      "a fork's branch of the same name",
      "develop-into-next",
      { ...resyncable, head: { ...resyncable.head, repo: { full_name: "someone/cli" } } },
    ],
    [
      "the main-into-develop pair",
      "main-into-develop",
      {
        state: "open",
        head: { ref: "sync/main-into-develop", repo: repoRef },
        base: { ref: "develop", repo: repoRef },
      },
    ],
  ])("refuses to resync %s", (_name, value, pullRequest) =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* setup();
        branchFromMain(repo, "next");
        branchFromMain(repo, "develop");
        const { io } = fakeIo(repo.checkout(), 31, pullRequest);

        yield* Effect.promise(() =>
          Promise.resolve(
            expect(syncBranches(io, parsePair(value), 31)).rejects.toThrow("is not an open"),
          ),
        );
      }),
    ),
  );

  test("retries when the target advances between fetch and push", () =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* setup();
        branchFromMain(repo, "develop");
        yield* repo.commit(repo.seed, "develop.txt", "develop\n", "feat: develop");
        git(repo.seed, "push", "origin", "develop");
        git(repo.seed, "switch", "main");
        const mainTip = yield* repo.commit(repo.seed, "main.txt", "main\n", "fix: hotfix");
        git(repo.seed, "push", "origin", "main");
        const { io } = fakeIo(repo.checkout());
        /* The late commit is made ahead, since the runner calls the wrapper below synchronously. */
        git(repo.seed, "switch", "develop");
        yield* repo.commit(repo.seed, "late.txt", "late\n", "feat: late");

        let raced = false;
        const racing: SyncIo = {
          ...io,
          git(args) {
            const result = io.git(args);
            if (!raced && args[0] === "fetch") {
              raced = true;
              git(repo.seed, "push", "origin", "develop");
            }
            return result;
          },
        };

        expect(yield* Effect.promise(() => syncBranches(racing, pair))).toEqual({
          status: "merged",
        });

        const developTip = repo.remoteTip("develop");
        expect(repo.isAncestor(mainTip, developTip)).toBe(true);
        expect(git(repo.remote, "show", `${developTip}^1:late.txt`)).toBe("late");
      }),
    ));
});
