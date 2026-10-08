import { afterEach, describe, expect, test } from "bun:test";

import {
  type CheckRun,
  type FastForwardIo,
  type GraphqlQuery,
  type Promotion,
  type PullRequest,
  type PullRequestAuthor,
  REQUIRED_CHECKS,
  type RollupContext,
  actionsCheckRuns,
  classifyPromotion,
  evaluateRequiredChecks,
  fetchPullRequestCheckRuns,
  isMajorPromotion,
  lastStableTag,
  runFastForward,
} from "./fast-forward.ts";
import { makeGit } from "./promotion-shared.ts";
import { createTestRepo, git, type TestRepo } from "./promotion-test-repo.ts";

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

const releaseBot: PullRequestAuthor = { login: "supabase-cli-releaser[bot]", type: "Bot" };
const maintainer: PullRequestAuthor = { login: "colum", type: "User" };

function run(name: string, conclusion: string | null, id = 1, completedAt?: string): CheckRun {
  return {
    id,
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    completedAt,
  };
}

const greenChecks = REQUIRED_CHECKS.map((name, index) => run(name, "success", index + 1));

describe("classifyPromotion", () => {
  const cases: [string, string, PullRequestAuthor, Promotion | undefined][] = [
    ["develop", "main", maintainer, { kind: "deploy", source: "develop", target: "main" }],
    ["next", "develop", maintainer, { kind: "cut", source: "next", target: "develop" }],
    [
      "sync/main-into-develop",
      "develop",
      releaseBot,
      { kind: "sync", source: "main", target: "develop" },
    ],
    [
      "sync/develop-into-next",
      "next",
      releaseBot,
      { kind: "sync", source: "develop", target: "next" },
    ],
    ["sync/main-into-develop", "develop", maintainer, undefined],
    ["sync/main-into-develop", "develop", { login: releaseBot.login, type: "User" }, undefined],
    ["sync/main-into-develop", "develop", { login: "dependabot[bot]", type: "Bot" }, undefined],
    ["sync/main-into-develop", "next", releaseBot, undefined],
    ["sync/develop-into-next", "develop", releaseBot, undefined],
    ["sync/foo-into-main", "main", releaseBot, undefined],
    ["sync/foo-into-v2.x", "v2.x", releaseBot, undefined],
    ["sync/main-into-main", "main", releaseBot, undefined],
    ["sync/api-package", "develop", releaseBot, undefined],
    ["sync/api-types", "develop", releaseBot, undefined],
    ["sync/-into-develop", "develop", releaseBot, undefined],
    ["develop", "next", maintainer, undefined],
    ["hotfix/x", "main", maintainer, undefined],
    ["next", "main", maintainer, undefined],
  ];

  test.each(cases)("%s into %s by %o", (head, base, author, expected) => {
    expect(classifyPromotion(head, base, author)).toEqual(expected);
  });

  test("a sync head without an author is not a promotion", () => {
    expect(classifyPromotion("sync/main-into-develop", "develop")).toBeUndefined();
  });
});

describe("evaluateRequiredChecks", () => {
  test("passes when every required check succeeded", () => {
    expect(evaluateRequiredChecks(greenChecks)).toEqual({ ok: true });
  });

  test("the latest run of a check wins over an older failure", () => {
    const runs = [
      run("Check code quality", "failure", 1, "2026-10-07T10:00:00Z"),
      run("Check code quality", "success", 2, "2026-10-07T11:00:00Z"),
      ...greenChecks.slice(1),
    ];
    expect(evaluateRequiredChecks(runs)).toEqual({ ok: true });
  });

  test("a newer failure beats an older success", () => {
    const runs = [
      run("Check code quality", "success", 1, "2026-10-07T10:00:00Z"),
      run("Check code quality", "failure", 2, "2026-10-07T11:00:00Z"),
      ...greenChecks.slice(1),
    ];
    expect(evaluateRequiredChecks(runs)).toMatchObject({
      ok: false,
      failing: [{ name: "Check code quality", conclusion: "failure" }],
    });
  });

  test("reports a missing check", () => {
    expect(evaluateRequiredChecks(greenChecks.slice(1))).toMatchObject({
      ok: false,
      missing: ["Check code quality"],
    });
  });

  test("reports a check that has not finished", () => {
    const runs = [
      run("Run end-to-end tests", null, 9),
      ...greenChecks.filter((r) => r.name !== "Run end-to-end tests"),
    ];
    expect(evaluateRequiredChecks(runs)).toMatchObject({
      ok: false,
      pending: ["Run end-to-end tests"],
    });
  });

  test("does not accept a prefixed reusable-workflow name", () => {
    const runs = [run("Test / Check code quality", "success", 9), ...greenChecks.slice(1)];
    expect(evaluateRequiredChecks(runs)).toMatchObject({
      ok: false,
      missing: ["Check code quality"],
    });
  });

  test("a skipped check does not pass", () => {
    const runs = [run("Lint Pull Request", "skipped", 9), ...greenChecks.slice(0, 3)];
    expect(evaluateRequiredChecks(runs)).toMatchObject({
      ok: false,
      failing: [{ name: "Lint Pull Request", conclusion: "skipped" }],
    });
  });
});

function pullRequestNode(number: number, nameWithOwner = "supabase/cli") {
  return { number, repository: { nameWithOwner } };
}

function rollupContext(name: string, conclusion: string, overrides: Partial<RollupContext> = {}) {
  return {
    __typename: "CheckRun",
    databaseId: name.length,
    name,
    status: "COMPLETED",
    conclusion,
    startedAt: "2026-10-07T10:00:00Z",
    completedAt: "2026-10-07T10:05:00Z",
    checkSuite: {
      app: { databaseId: 15368 },
      matchingPullRequests: { nodes: [pullRequestNode(7)] },
    },
    ...overrides,
  } satisfies RollupContext;
}

function rollupPage(
  contexts: RollupContext[],
  options: { oid?: string; endCursor?: string | null } = {},
) {
  return {
    repository: {
      pullRequest: {
        commits: {
          nodes: [
            {
              commit: {
                oid: options.oid ?? "abc",
                statusCheckRollup: {
                  contexts: {
                    pageInfo: {
                      hasNextPage: options.endCursor != null,
                      endCursor: options.endCursor ?? null,
                    },
                    nodes: contexts,
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}

describe("actionsCheckRuns", () => {
  test("maps GraphQL enums to the lowercase vocabulary", () => {
    const [mapped] = actionsCheckRuns(
      [rollupContext("Check code quality", "SUCCESS")],
      "supabase/cli",
      7,
    );
    expect(mapped).toMatchObject({
      name: "Check code quality",
      status: "completed",
      conclusion: "success",
    });
  });

  test("drops runs of other apps", () => {
    const foreign = rollupContext("Check code quality", "SUCCESS", {
      checkSuite: {
        app: { databaseId: 99 },
        matchingPullRequests: { nodes: [pullRequestNode(7)] },
      },
    });
    expect(actionsCheckRuns([foreign], "supabase/cli", 7)).toEqual([]);
  });

  test("drops runs attached to another pull request on the same commit", () => {
    const other = rollupContext("Check code quality", "SUCCESS", {
      checkSuite: {
        app: { databaseId: 15368 },
        matchingPullRequests: { nodes: [pullRequestNode(8)] },
      },
    });
    const orphan = rollupContext("Run end-to-end tests", "SUCCESS", {
      checkSuite: { app: { databaseId: 15368 }, matchingPullRequests: { nodes: [] } },
    });
    expect(actionsCheckRuns([other, orphan], "supabase/cli", 7)).toEqual([]);
  });

  test("drops runs attached to a same-numbered pull request of another repository", () => {
    const fork = rollupContext("Check code quality", "SUCCESS", {
      checkSuite: {
        app: { databaseId: 15368 },
        matchingPullRequests: { nodes: [pullRequestNode(7, "someone/cli")] },
      },
    });
    expect(actionsCheckRuns([fork], "supabase/cli", 7)).toEqual([]);
  });

  test("keeps a run whose suite lists both a fork pull request and this one", () => {
    const shared = rollupContext("Check code quality", "SUCCESS", {
      checkSuite: {
        app: { databaseId: 15368 },
        matchingPullRequests: {
          nodes: [pullRequestNode(7, "someone/cli"), pullRequestNode(7)],
        },
      },
    });
    expect(actionsCheckRuns([shared], "supabase/cli", 7)).toHaveLength(1);
  });

  test("ignores commit statuses", () => {
    expect(actionsCheckRuns([{ __typename: "StatusContext" }], "supabase/cli", 7)).toEqual([]);
  });

  test("a masking failure from another pull request cannot hide a green required check", () => {
    const green = rollupContext("Check code quality", "SUCCESS");
    const foreignFailure = rollupContext("Check code quality", "FAILURE", {
      databaseId: 999,
      completedAt: "2026-10-07T11:00:00Z",
      checkSuite: {
        app: { databaseId: 15368 },
        matchingPullRequests: { nodes: [pullRequestNode(8)] },
      },
    });
    const runs = actionsCheckRuns([green, foreignFailure], "supabase/cli", 7);
    expect(evaluateRequiredChecks(runs, ["Check code quality"])).toEqual({ ok: true });
  });
});

describe("fetchPullRequestCheckRuns", () => {
  function fakeGraphql(pages: unknown[]): { query: GraphqlQuery; cursors: unknown[] } {
    const cursors: unknown[] = [];
    const query: GraphqlQuery = async (_query, variables) => {
      cursors.push(variables.cursor);
      return pages[cursors.length - 1];
    };
    return { query, cursors };
  }

  test("follows pagination and returns the pull request's Actions runs", async () => {
    const { query, cursors } = fakeGraphql([
      rollupPage([rollupContext("Check code quality", "SUCCESS")], { endCursor: "c1" }),
      rollupPage([rollupContext("Lint Pull Request", "SUCCESS")]),
    ]);

    const runs = await fetchPullRequestCheckRuns(query, "supabase/cli", 7, "abc");

    expect(runs.map((r) => r.name)).toEqual(["Check code quality", "Lint Pull Request"]);
    expect(cursors).toEqual([null, "c1"]);
  });

  test("passes owner, name and number as variables", async () => {
    const seen: Record<string, unknown>[] = [];
    await fetchPullRequestCheckRuns(
      async (_query, variables) => {
        seen.push(variables);
        return rollupPage([]);
      },
      "supabase/cli",
      7,
      "abc",
    );
    expect(seen[0]).toMatchObject({ owner: "supabase", name: "cli", number: 7 });
  });

  test("returns no runs when the commit has no rollup", async () => {
    const page = rollupPage([]);
    const commit = page.repository.pullRequest.commits.nodes[0]!.commit as {
      statusCheckRollup: unknown;
    };
    commit.statusCheckRollup = null;
    const { query } = fakeGraphql([page]);

    expect(await fetchPullRequestCheckRuns(query, "supabase/cli", 7, "abc")).toEqual([]);
  });

  test("fails when the head commit changed", async () => {
    const { query } = fakeGraphql([rollupPage([], { oid: "def" })]);
    await expect(fetchPullRequestCheckRuns(query, "supabase/cli", 7, "abc")).rejects.toThrow(
      "no longer abc",
    );
  });
});

describe("lastStableTag", () => {
  test("ignores prereleases and orders numerically", () => {
    expect(
      lastStableTag([
        "v2.99.0",
        "v2.100.0",
        "v3.0.0-beta.1",
        "v2.100.0-next.4",
        "latest",
        "v2.9.9",
      ]),
    ).toBe("v2.100.0");
  });

  test("returns undefined without a stable tag", () => {
    expect(lastStableTag(["v1.0.0-beta.1"])).toBeUndefined();
  });
});

function tagMain(repo: TestRepo, tag: string): void {
  git(repo.seed, "tag", tag);
  git(repo.seed, "push", "origin", tag);
}

describe("isMajorPromotion", () => {
  test("detects a breaking commit after the last stable tag", () => {
    const repo = setup();
    repo.commit(repo.seed, "old.txt", "old\n", "feat(cli)!: old break");
    tagMain(repo, "v1.0.0");
    git(repo.seed, "push", "origin", "main");
    git(repo.seed, "switch", "-c", "develop");
    repo.commit(repo.seed, "a.txt", "a\n", "fix(cli): small");
    const head = repo.commit(repo.seed, "b.txt", "b\n", "feat(cli)!: break things");
    git(repo.seed, "push", "origin", "develop");
    const checkout = repo.checkout();

    expect(isMajorPromotion(makeGit(checkout), head, "main")).toBe(true);
  });

  test("ignores breaking commits that precede the last stable tag", () => {
    const repo = setup();
    repo.commit(repo.seed, "old.txt", "old\n", "feat(cli)!: old break");
    tagMain(repo, "v1.0.0");
    git(repo.seed, "push", "origin", "main");
    git(repo.seed, "switch", "-c", "develop");
    const head = repo.commit(repo.seed, "a.txt", "a\n", "feat(cli): minor");
    git(repo.seed, "push", "origin", "develop");
    const checkout = repo.checkout();

    expect(isMajorPromotion(makeGit(checkout), head, "main")).toBe(false);
  });

  test("a sync merge commit message is not breaking", () => {
    const repo = setup();
    tagMain(repo, "v1.0.0");
    git(repo.seed, "switch", "-c", "develop");
    repo.commit(repo.seed, "d.txt", "d\n", "fix(cli): d");
    git(repo.seed, "switch", "main");
    repo.commit(repo.seed, "m.txt", "m\n", "fix(cli): m");
    git(repo.seed, "push", "origin", "main");
    git(repo.seed, "switch", "develop");
    git(repo.seed, "merge", "--no-edit", "main");
    const head = git(repo.seed, "rev-parse", "HEAD");
    git(repo.seed, "push", "origin", "develop");
    const checkout = repo.checkout();

    expect(isMajorPromotion(makeGit(checkout), head, "main")).toBe(false);
  });
});

interface Scenario {
  repo: TestRepo;
  checkout: string;
  head: string;
  comments: string[];
  lookups: string[];
  io: FastForwardIo;
  pullRequest: PullRequest;
}

function scenarioIo(
  repo: TestRepo,
  checkout: string,
  pullRequest: PullRequest,
  checks: CheckRun[],
  openSyncPullRequest?: number | Error,
): { io: FastForwardIo; comments: string[]; lookups: string[] } {
  const comments: string[] = [];
  const lookups: string[] = [];
  const io: FastForwardIo = {
    git: makeGit(checkout),
    getPullRequest: async () => pullRequest,
    listCheckRuns: async () => checks,
    findOpenPullRequest: async (base, head) => {
      lookups.push(`${base}<-${head}`);
      if (openSyncPullRequest instanceof Error) {
        throw openSyncPullRequest;
      }
      return openSyncPullRequest;
    },
    comment: async (body) => {
      comments.push(body);
    },
  };
  return { io, comments, lookups };
}

function publish(repo: TestRepo, number: number): void {
  git(repo.seed, "push", "--force", "origin", `HEAD:refs/pull/${number}/head`);
}

function deployScenario(
  options: {
    headMessage?: string;
    labels?: string[];
    checks?: CheckRun[];
    openSyncPullRequest?: number | Error;
  } = {},
): Scenario {
  const repo = setup();
  tagMain(repo, "v1.0.0");
  git(repo.seed, "switch", "-c", "develop");
  repo.commit(repo.seed, "a.txt", "a\n", "fix(cli): a");
  const head = repo.commit(repo.seed, "b.txt", "b\n", options.headMessage ?? "feat(cli): b");
  git(repo.seed, "push", "origin", "develop");
  publish(repo, 7);
  const checkout = repo.checkout();
  const pullRequest: PullRequest = {
    number: 7,
    state: "open",
    draft: false,
    user: maintainer,
    head: { sha: head, ref: "develop" },
    base: { ref: "main" },
    labels: (options.labels ?? []).map((name) => ({ name })),
  };
  const { io, comments, lookups } = scenarioIo(
    repo,
    checkout,
    pullRequest,
    options.checks ?? greenChecks,
    options.openSyncPullRequest,
  );
  return { repo, checkout, head, comments, lookups, io, pullRequest };
}

describe("runFastForward deploy", () => {
  test("fast-forwards main to the approved head without commenting", async () => {
    const { repo, head, io, comments } = deployScenario();

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome).toEqual({ status: "fast-forwarded", sha: head });
    expect(repo.remoteTip("main")).toBe(head);
    expect(comments).toEqual([]);
  });

  test("refuses a stale approval", async () => {
    const { repo, io, comments } = deployScenario();
    const mainBefore = repo.remoteTip("main");

    const outcome = await runFastForward(io, { reviewCommitId: "0".repeat(40) });

    expect(outcome.status).toBe("refused");
    expect(repo.remoteTip("main")).toBe(mainBefore);
    expect(comments[0]).toContain("Re-approve the current head");
  });

  test("refuses when required checks are not green", async () => {
    const { repo, head, io, comments } = deployScenario({
      checks: [run("Check code quality", "failure"), ...greenChecks.slice(1)],
    });
    const mainBefore = repo.remoteTip("main");

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome.status).toBe("refused");
    expect(repo.remoteTip("main")).toBe(mainBefore);
    expect(comments[0]).toContain("| Check code quality | failure |");
  });

  test("refuses a major release without the release-major label", async () => {
    const { repo, head, io, comments } = deployScenario({ headMessage: "feat(cli)!: break" });
    const mainBefore = repo.remoteTip("main");

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome.status).toBe("refused");
    expect(repo.remoteTip("main")).toBe(mainBefore);
    expect(comments[0]).toContain("release-major");
  });

  test("accepts a major release with the release-major label", async () => {
    const { repo, head, io } = deployScenario({
      headMessage: "feat(cli)!: break",
      labels: ["release-major"],
    });

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome.status).toBe("fast-forwarded");
    expect(repo.remoteTip("main")).toBe(head);
  });

  test("refuses when main moved after the head was cut and points at the sync workflow", async () => {
    const { repo, head, io, comments } = deployScenario();
    git(repo.seed, "switch", "main");
    const movedMain = repo.commit(repo.seed, "hotfix.txt", "fix\n", "fix(cli): hotfix");
    git(repo.seed, "push", "origin", "main");

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome.status).toBe("refused");
    expect(repo.remoteTip("main")).toBe(movedMain);
    expect(comments[0]).toContain("moved since approval");
    expect(comments[0]).toContain("pair=main-into-develop");
  });

  test("names the open back-merge pull request when main has a hotfix develop lacks", async () => {
    const { repo, head, io, comments, lookups } = deployScenario({ openSyncPullRequest: 42 });
    git(repo.seed, "switch", "main");
    repo.commit(repo.seed, "hotfix.txt", "fix\n", "fix(cli): hotfix");
    git(repo.seed, "push", "origin", "main");

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome.status).toBe("refused");
    expect(lookups).toEqual(["develop<-sync/main-into-develop"]);
    expect(comments[0]).toContain("waiting in #42");
  });

  test("still comments with the dispatch guidance when the sync pull request lookup fails", async () => {
    const { repo, head, io, comments, lookups } = deployScenario({
      openSyncPullRequest: new Error("api down"),
    });
    git(repo.seed, "switch", "main");
    repo.commit(repo.seed, "hotfix.txt", "fix\n", "fix(cli): hotfix");
    git(repo.seed, "push", "origin", "main");

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome.status).toBe("refused");
    expect(lookups).toEqual(["develop<-sync/main-into-develop"]);
    expect(comments[0]).toContain("moved since approval");
    expect(comments[0]).toContain("pair=main-into-develop");
  });

  test("refuses when main moves between the ancestry check and the push", async () => {
    const { repo, head, io, comments } = deployScenario();
    git(repo.seed, "switch", "main");
    const movedMain = repo.commit(repo.seed, "hotfix.txt", "fix\n", "fix(cli): hotfix");
    const racing: FastForwardIo = {
      ...io,
      git(args) {
        if (args[0] === "push") {
          git(repo.seed, "push", "origin", "main");
        }
        return io.git(args);
      },
    };

    const outcome = await runFastForward(racing, { reviewCommitId: head });

    expect(outcome.status).toBe("refused");
    expect(repo.remoteTip("main")).toBe(movedMain);
    expect(comments[0]).toContain("moved since approval");
  });

  test("ignores pull requests that are not promotions", async () => {
    const { repo, head, io, pullRequest, comments } = deployScenario();
    pullRequest.head.ref = "feature/x";
    const mainBefore = repo.remoteTip("main");

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome.status).toBe("ignored");
    expect(comments).toEqual([]);
    expect(repo.remoteTip("main")).toBe(mainBefore);
  });

  test("dry run neither pushes nor comments", async () => {
    const { repo, head, io, comments } = deployScenario();
    const mainBefore = repo.remoteTip("main");

    const outcome = await runFastForward(io, { reviewCommitId: head, dryRun: true });

    expect(outcome.status).toBe("dry-run");
    expect(repo.remoteTip("main")).toBe(mainBefore);
    expect(comments).toEqual([]);
  });
});

describe("runFastForward cut", () => {
  test("fast-forwards develop to next without the major guard", async () => {
    const repo = setup();
    tagMain(repo, "v1.0.0");
    git(repo.seed, "switch", "-c", "develop");
    git(repo.seed, "push", "origin", "develop");
    git(repo.seed, "switch", "-c", "next");
    const head = repo.commit(repo.seed, "v3.txt", "v3\n", "feat(cli)!: v3");
    git(repo.seed, "push", "origin", "next");
    publish(repo, 11);
    const pullRequest: PullRequest = {
      number: 11,
      state: "open",
      draft: false,
      user: maintainer,
      head: { sha: head, ref: "next" },
      base: { ref: "develop" },
      labels: [],
    };
    const { io } = scenarioIo(repo, repo.checkout(), pullRequest, greenChecks);

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome.status).toBe("fast-forwarded");
    expect(repo.remoteTip("develop")).toBe(head);
  });
});

interface SyncScenario {
  repo: TestRepo;
  head: string;
  io: FastForwardIo;
  comments: string[];
}

function resolvedSyncScenario(): SyncScenario {
  const repo = setup();
  git(repo.seed, "switch", "-c", "develop");
  repo.commit(repo.seed, "shared.txt", "develop\n", "feat(cli): develop edit");
  git(repo.seed, "push", "origin", "develop");
  git(repo.seed, "switch", "main");
  repo.commit(repo.seed, "shared.txt", "main\n", "fix(cli): main edit");
  git(repo.seed, "push", "origin", "main");
  git(repo.seed, "switch", "-c", "sync/main-into-develop");
  try {
    git(repo.seed, "merge", "--no-edit", "develop");
  } catch {
    repo.commit(repo.seed, "shared.txt", "resolved\n", "chore(repo): resolve sync");
  }
  const head = git(repo.seed, "rev-parse", "HEAD");
  git(repo.seed, "push", "origin", "sync/main-into-develop");
  publish(repo, 21);
  const pullRequest: PullRequest = {
    number: 21,
    state: "open",
    draft: false,
    user: releaseBot,
    head: { sha: head, ref: "sync/main-into-develop" },
    base: { ref: "develop" },
    labels: [],
  };
  const { io, comments } = scenarioIo(repo, repo.checkout(), pullRequest, greenChecks);
  return { repo, head, io, comments };
}

describe("runFastForward sync", () => {
  test("refuses a sync pull request opened by a person and points at the workflow", async () => {
    const { repo, head, io, comments } = resolvedSyncScenario();
    const before = repo.remoteTip("develop");
    const humanPr = { ...(await io.getPullRequest()), user: maintainer };

    const outcome = await runFastForward(
      { ...io, getPullRequest: async () => humanPr },
      { reviewCommitId: head },
    );

    expect(outcome.status).toBe("refused");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("gh workflow run sync-branches.yml -f pair=main-into-develop");
    expect(comments[0]).toContain("Close this pull request");
    expect(repo.remoteTip("develop")).toBe(before);
  });

  test("ignores a closed sync pull request opened by a person", async () => {
    const { head, io, comments } = resolvedSyncScenario();
    const closed = { ...(await io.getPullRequest()), user: maintainer, state: "closed" };

    const outcome = await runFastForward(
      { ...io, getPullRequest: async () => closed },
      { reviewCommitId: head },
    );

    expect(outcome.status).toBe("ignored");
    expect(comments).toEqual([]);
  });

  test("fast-forwards the target and deletes the sync branch", async () => {
    const { repo, head, io } = resolvedSyncScenario();

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome.status).toBe("fast-forwarded");
    expect(repo.remoteTip("develop")).toBe(head);
    expect(() => repo.remoteTip("sync/main-into-develop")).toThrow();
  });

  test("lands the approved head merged with a non-conflicting target move", async () => {
    const { repo, head, io, comments } = resolvedSyncScenario();
    git(repo.seed, "switch", "develop");
    const movedDevelop = repo.commit(repo.seed, "late.txt", "late\n", "feat(cli): late");
    git(repo.seed, "push", "origin", "develop");

    const outcome = await runFastForward(io, { reviewCommitId: head });

    const landed = repo.remoteTip("develop");
    expect(outcome).toEqual({ status: "merged-after-resync", sha: landed });
    expect(repo.isAncestor(head, landed)).toBe(true);
    expect(repo.isAncestor(movedDevelop, landed)).toBe(true);
    expect(() => repo.remoteTip("sync/main-into-develop")).toThrow();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("moved since approval");
    expect(comments[0]).toContain(`landed it as ${landed.slice(0, 7)}`);
    expect(comments[0]).not.toContain("Re-approve");
  });

  test("retries the merge when the target moves again before the push", async () => {
    const { repo, head, io } = resolvedSyncScenario();
    git(repo.seed, "switch", "develop");
    repo.commit(repo.seed, "late-1.txt", "1\n", "feat(cli): late 1");
    git(repo.seed, "push", "origin", "develop");
    let raced = false;
    const racing: FastForwardIo = {
      ...io,
      git(args) {
        if (args[0] === "push" && !raced) {
          raced = true;
          repo.commit(repo.seed, "late-2.txt", "2\n", "feat(cli): late 2");
          git(repo.seed, "push", "origin", "develop");
        }
        return io.git(args);
      },
    };

    const outcome = await runFastForward(racing, { reviewCommitId: head });

    const landed = repo.remoteTip("develop");
    expect(outcome).toEqual({ status: "merged-after-resync", sha: landed });
    expect(git(repo.remote, "ls-tree", "--name-only", landed)).toContain("late-2.txt");
    expect(repo.isAncestor(head, landed)).toBe(true);
  });

  test("falls back to re-approval when the target keeps moving", async () => {
    const { repo, head, io, comments } = resolvedSyncScenario();
    git(repo.seed, "switch", "develop");
    let movedDevelop = repo.commit(repo.seed, "late-0.txt", "late\n", "feat(cli): late 0");
    git(repo.seed, "push", "origin", "develop");
    let moves = 0;
    const racing: FastForwardIo = {
      ...io,
      git(args) {
        if (args[0] === "push" && args[2] === "HEAD:refs/heads/develop") {
          moves += 1;
          movedDevelop = repo.commit(
            repo.seed,
            `late-${moves}.txt`,
            "late\n",
            `feat(cli): late ${moves}`,
          );
          git(repo.seed, "push", "origin", "develop");
        }
        return io.git(args);
      },
    };

    const outcome = await runFastForward(racing, { reviewCommitId: head });

    expect(outcome.status).toBe("resynced");
    expect(moves).toBe(3);
    expect(repo.remoteTip("develop")).toBe(movedDevelop);
    const resynced = repo.remoteTip("sync/main-into-develop");
    expect(resynced).not.toBe(head);
    expect(repo.isAncestor(head, resynced)).toBe(true);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("Re-approve");
  });

  test("dry run pushes nothing when the target moved cleanly", async () => {
    const { repo, head, io, comments } = resolvedSyncScenario();
    git(repo.seed, "switch", "develop");
    const movedDevelop = repo.commit(repo.seed, "late.txt", "late\n", "feat(cli): late");
    git(repo.seed, "push", "origin", "develop");

    const outcome = await runFastForward(io, { reviewCommitId: head, dryRun: true });

    expect(outcome.status).toBe("dry-run");
    expect(repo.remoteTip("develop")).toBe(movedDevelop);
    expect(repo.remoteTip("sync/main-into-develop")).toBe(head);
    expect(comments).toEqual([]);
  });

  test("refuses and leaves the branch alone when a moved target conflicts", async () => {
    const { repo, head, io, comments } = resolvedSyncScenario();
    git(repo.seed, "switch", "develop");
    const movedDevelop = repo.commit(
      repo.seed,
      "shared.txt",
      "conflicting\n",
      "feat(cli): conflicting",
    );
    git(repo.seed, "push", "origin", "develop");

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome.status).toBe("refused");
    expect(repo.remoteTip("sync/main-into-develop")).toBe(head);
    expect(repo.remoteTip("develop")).toBe(movedDevelop);
    expect(comments[0]).toContain("- `shared.txt`");
  });

  test("lands the approved head merged with a non-conflicting source move", async () => {
    const { repo, head, io, comments } = resolvedSyncScenario();
    git(repo.seed, "switch", "main");
    const movedMain = repo.commit(repo.seed, "late-main.txt", "late\n", "fix(cli): late main");
    git(repo.seed, "push", "origin", "main");

    const outcome = await runFastForward(io, { reviewCommitId: head });

    const landed = repo.remoteTip("develop");
    expect(outcome).toEqual({ status: "merged-after-resync", sha: landed });
    expect(landed).not.toBe(head);
    expect(repo.isAncestor(head, landed)).toBe(true);
    expect(repo.isAncestor(movedMain, landed)).toBe(true);
    expect(() => repo.remoteTip("sync/main-into-develop")).toThrow();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("`main` moved since approval");
  });

  test("refuses and leaves the branch alone when a moved source conflicts", async () => {
    const { repo, head, io, comments } = resolvedSyncScenario();
    const developBefore = repo.remoteTip("develop");
    git(repo.seed, "switch", "main");
    repo.commit(repo.seed, "shared.txt", "conflicting main\n", "fix(cli): conflicting main");
    git(repo.seed, "push", "origin", "main");

    const outcome = await runFastForward(io, { reviewCommitId: head });

    expect(outcome.status).toBe("refused");
    expect(repo.remoteTip("sync/main-into-develop")).toBe(head);
    expect(repo.remoteTip("develop")).toBe(developBefore);
    expect(comments[0]).toContain("`main` moved since approval");
    expect(comments[0]).toContain("- `shared.txt`");
  });

  test("dry run pushes nothing when the source moved cleanly", async () => {
    const { repo, head, io, comments } = resolvedSyncScenario();
    const developBefore = repo.remoteTip("develop");
    git(repo.seed, "switch", "main");
    repo.commit(repo.seed, "late-main.txt", "late\n", "fix(cli): late main");
    git(repo.seed, "push", "origin", "main");

    const outcome = await runFastForward(io, { reviewCommitId: head, dryRun: true });

    expect(outcome.status).toBe("dry-run");
    expect(repo.remoteTip("develop")).toBe(developBefore);
    expect(repo.remoteTip("sync/main-into-develop")).toBe(head);
    expect(comments).toEqual([]);
  });
});
