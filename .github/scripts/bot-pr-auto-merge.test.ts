import { afterEach, describe, expect, test } from "bun:test";

import {
  APPROVER_LOGIN,
  ApprovalGuardViolation,
  type ActivityEvent,
  type BotPr,
  type BotPrIo,
  type BotPrState,
  type BotPrSweepEntry,
  type PrReview,
  assertApprovable,
  createBotPrIo,
  renderSummary,
  sweepBotPrs,
} from "./bot-pr-auto-merge.ts";

const REPO = "supabase/cli";
const RELEASER = "supabase-cli-releaser[bot]";
const DEPENDABOT = "dependabot[bot]";
const SHA = "a".repeat(40);

function pr(overrides: Partial<BotPr> = {}): BotPr {
  return {
    number: 1,
    nodeId: "PR_1",
    draft: false,
    baseRef: "develop",
    headRef: "sync/api-package",
    headSha: SHA,
    headRepo: REPO,
    authorLogin: RELEASER,
    labels: [],
    assignees: [],
    autoMergeEnabled: false,
    ...overrides,
  };
}

const deployPr = pr({
  number: 7771,
  baseRef: "main",
  headRef: "develop",
  labels: ["do not merge"],
  headRepo: REPO,
});

const cleanHistory = (bot: string): ActivityEvent[] => [
  { type: "branch_creation", actor: bot, after: SHA },
];

interface Fake {
  io: BotPrIo;
  writes: string[];
}

function fakeIo(
  prs: BotPr[],
  options: {
    activity?: (headRef: string) => ActivityEvent[];
    reviews?: PrReview[];
    failOn?: number;
    failCall?: string;
    failReviews?: boolean;
    refresh?: Partial<BotPrState>;
    refreshSequence?: Partial<BotPrState>[];
    failActivity?: boolean;
  } = {},
): Fake {
  const writes: string[] = [];
  const record = (name: string, target: BotPr) => {
    if (target.number === options.failOn) {
      throw new Error(`io failure on #${target.number}`);
    }
    if (name === options.failCall) {
      throw new Error(`${name} failed`);
    }
    writes.push(`${name}:${target.number}`);
  };
  let refreshCalls = 0;
  const io: BotPrIo = {
    listPrs: async () => prs,
    listBranchActivity: async (headRef) => {
      if (options.failActivity) {
        throw new Error("activity unavailable upstream");
      }
      return (
        options.activity?.(headRef) ??
        cleanHistory(headRef.startsWith("dependabot/") ? DEPENDABOT : RELEASER)
      );
    },
    listReviews: async () => {
      if (options.failReviews) {
        throw new Error("reviews unavailable");
      }
      return options.reviews ?? [];
    },
    approve: async (target) => {
      record("approve", target);
    },
    refresh: async (target) => {
      const state = {
        open: true,
        draft: target.draft,
        baseRef: target.baseRef,
        headRef: target.headRef,
        headSha: target.headSha,
        labels: target.labels,
        autoMergeEnabled: target.autoMergeEnabled,
        inMergeQueue: false,
        ...options.refresh,
        ...options.refreshSequence?.[refreshCalls++],
      };
      return {
        autoMergeByBot: state.autoMergeEnabled,
        queuedByBot: state.inMergeQueue,
        ...state,
      };
    },
    queue: async (target) => {
      record("queue", target);
    },
    dequeue: async (target) => record("dequeue", target),
    disableAutoMerge: async (target) => record("disableAutoMerge", target),
    dismissReview: async (target, reviewId) => record(`dismiss(${reviewId})`, target),
    assignApprover: async (target) => record("assign", target),
  };
  return { io, writes };
}

const run = (io: BotPrIo, dryRun = false) => sweepBotPrs(io, { repository: REPO, dryRun });

describe("assertApprovable", () => {
  const ok = { number: 1, baseRef: "develop", headRef: "sync/api-package", labels: [] };

  test.each([
    "develop",
    "next",
    "sync/main-into-develop",
    "release-notes/x",
    "hotfix/x",
    "backport/x",
  ])("rejects head %s", (headRef) => {
    expect(() => assertApprovable({ ...ok, headRef })).toThrow(ApprovalGuardViolation);
  });

  test.each(["main", "next"])("rejects base %s", (baseRef) => {
    expect(() => assertApprovable({ ...ok, baseRef })).toThrow(/base is/);
  });

  test.each(["do not merge", "Do Not Merge"])("rejects the %s label", (label) => {
    expect(() => assertApprovable({ ...ok, labels: ["bug", label] })).toThrow(/do not merge/);
  });

  test.each([
    "sync/api-package",
    "slim-bump/realtime",
    "slim-hotfix/realtime",
    "dependabot/npm_and_yarn/x",
  ])("allows head %s", (headRef) => {
    expect(() => assertApprovable({ ...ok, headRef })).not.toThrow();
  });
});

describe("sweepBotPrs deploy protection", () => {
  test("ignores a production deploy pull request and writes nothing", async () => {
    const { io, writes } = fakeIo([deployPr]);

    expect(await run(io)).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("holds an otherwise eligible bot pull request labelled `do not merge` without writing or failing", async () => {
    const labelled = pr({ number: 7771, labels: ["do not merge"] });
    const { io, writes } = fakeIo([labelled]);

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries).toEqual([
      {
        number: 7771,
        headRef: "sync/api-package",
        verdict: "held (labelled `do not merge`)",
        actions: [],
      },
    ]);
  });

  test("reports a guard violation when the live base is no longer develop", async () => {
    const { io, writes } = fakeIo([pr()], { refresh: { baseRef: "main" } });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]).toMatchObject({ verdict: "error", actions: [], guardViolation: true });
    expect(entries[0]?.error).toContain("base is `main`");
  });
});

describe("sweepBotPrs eligibility", () => {
  test.each([
    ["dependabot branch opened by the releaser", { headRef: "dependabot/npm_and_yarn/x" }],
    ["releaser branch opened by dependabot", { authorLogin: DEPENDABOT }],
    ["fork head", { headRepo: "someone/cli" }],
    ["deleted fork head", { headRepo: null }],
    ["unknown branch family", { headRef: "feature/x" }],
    ["human author on a bot branch", { authorLogin: "jgoux" }],
  ] as [string, Partial<BotPr>][])("ignores a %s", async (_name, overrides) => {
    const { io, writes } = fakeIo([pr(overrides)]);

    expect(await run(io)).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("sweepBotPrs provenance", () => {
  test("approves and queues a slim-hotfix branch opened by the releaser", async () => {
    const { io, writes } = fakeIo([pr({ headRef: "slim-hotfix/realtime" })]);

    const entries = await run(io);

    expect(writes).toEqual(["assign:1", "approve:1", "queue:1"]);
    expect(entries[0]).toMatchObject({
      verdict: "trusted",
      actions: ["assign approver", "approve", "queue"],
    });
  });

  test("approves the head and enables auto-merge for a bot-only branch", async () => {
    const { io, writes } = fakeIo([pr()]);

    const entries = await run(io);

    expect(writes).toEqual(["assign:1", "approve:1", "queue:1"]);
    expect(entries).toEqual([
      {
        number: 1,
        headRef: "sync/api-package",
        verdict: "trusted",
        actions: ["assign approver", "approve", "queue"],
      },
    ]);
  });

  test("approves a dependabot branch pushed only by dependabot", async () => {
    const { io, writes } = fakeIo([
      pr({ headRef: "dependabot/npm_and_yarn/x", authorLogin: DEPENDABOT }),
    ]);

    await run(io);

    expect(writes).toContain("approve:1");
    expect(writes).toContain("queue:1");
  });

  test("withholds approval after a human pushed to the branch", async () => {
    const { io, writes } = fakeIo([pr()], {
      activity: () => [
        { type: "push", actor: "jgoux", after: SHA },
        { type: "branch_creation", actor: RELEASER, after: "b".repeat(40) },
      ],
    });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]?.verdict).toBe("tainted (push by jgoux)");
  });

  test("dismisses the bot approval and disables auto-merge after a human push", async () => {
    const { io, writes } = fakeIo([pr({ autoMergeEnabled: true, assignees: [APPROVER_LOGIN] })], {
      activity: () => [
        { type: "force_push", actor: "jgoux", after: SHA },
        { type: "branch_creation", actor: RELEASER, after: "b".repeat(40) },
      ],
      reviews: [{ id: 99, user: APPROVER_LOGIN, state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual(["disableAutoMerge:1", "dismiss(99):1"]);
    expect(entries[0]?.actions).toEqual(["disable auto-merge", "dismiss approval"]);
  });

  test("treats a merge event by a human as tainted", async () => {
    const { io, writes } = fakeIo([pr()], {
      activity: () => [
        { type: "pr_merge", actor: "jgoux", after: SHA },
        { type: "branch_creation", actor: RELEASER, after: SHA },
      ],
    });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]?.verdict).toBe("tainted (push by jgoux)");
  });

  test("treats a push with a null actor as tainted", async () => {
    const { io, writes } = fakeIo([pr()], {
      activity: () => [
        { type: "push", actor: null, after: SHA },
        { type: "branch_creation", actor: RELEASER, after: "b".repeat(40) },
      ],
    });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]?.verdict).toBe("tainted (push by an unknown actor)");
  });

  test("makes no writes while branch creation is missing from activity", async () => {
    const { io, writes } = fakeIo([pr({ autoMergeEnabled: true })], {
      activity: () => [{ type: "push", actor: RELEASER, after: SHA }],
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]?.verdict).toStartWith("pending");
  });

  test("makes no writes while the newest activity does not match the head", async () => {
    const { io, writes } = fakeIo([pr()], {
      activity: () => [{ type: "branch_creation", actor: RELEASER, after: "c".repeat(40) }],
    });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]?.verdict).toStartWith("pending");
  });
});

describe("sweepBotPrs idempotence and modes", () => {
  test("makes no writes when already assigned, approved and auto-merge already enabled", async () => {
    const { io, writes } = fakeIo([pr({ autoMergeEnabled: true, assignees: [APPROVER_LOGIN] })], {
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]).toMatchObject({ verdict: "trusted", actions: [] });
  });

  test("holds a dismissed approval instead of re-approving it", async () => {
    const { io, writes } = fakeIo([pr({ assignees: [APPROVER_LOGIN] })], {
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "DISMISSED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]).toMatchObject({ verdict: "held (approval dismissed)", actions: [] });
  });

  test("withdraws bot-created auto-merge and queue entry when a maintainer dismissed the bot approval", async () => {
    const { io, writes } = fakeIo([pr({ autoMergeEnabled: true, assignees: [APPROVER_LOGIN] })], {
      refresh: { inMergeQueue: true },
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "DISMISSED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual(["dequeue:1", "disableAutoMerge:1"]);
    expect(entries[0]).toMatchObject({
      verdict: "held (approval dismissed)",
      actions: ["dequeue", "disable auto-merge"],
    });
  });

  test("holds a draft PR, dismisses its bot approval and disables auto-merge", async () => {
    const { io, writes } = fakeIo(
      [pr({ draft: true, autoMergeEnabled: true, assignees: [APPROVER_LOGIN] })],
      { reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }] },
    );

    const entries = await run(io);

    expect(writes).toEqual(["disableAutoMerge:1", "dismiss(5):1"]);
    expect(entries[0]).toMatchObject({
      verdict: "held (draft)",
      actions: ["disable auto-merge", "dismiss approval"],
    });
  });

  test("enforces a label hold even while provenance is pending", async () => {
    const { io, writes } = fakeIo([pr({ labels: ["do not merge"], autoMergeEnabled: true })], {
      activity: () => [{ type: "push", actor: RELEASER, after: SHA }],
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual(["disableAutoMerge:1", "dismiss(5):1"]);
    expect(entries[0]?.verdict).toBe("held (labelled `do not merge`)");
  });

  test("dismisses every active bot approval, not just the latest", async () => {
    const { io, writes } = fakeIo([pr({ labels: ["do not merge"] })], {
      reviews: [
        { id: 5, user: APPROVER_LOGIN, state: "APPROVED" },
        { id: 6, user: APPROVER_LOGIN, state: "APPROVED" },
      ],
    });

    await run(io);

    expect(writes).toEqual(["dismiss(5):1", "dismiss(6):1"]);
  });

  test("withdraws sweep-owned queue entry and auto-merge from a tainted PR a maintainer approved", async () => {
    const { io, writes } = fakeIo([pr({ autoMergeEnabled: true })], {
      activity: () => [
        { type: "push", actor: "jgoux", after: SHA },
        { type: "branch_creation", actor: RELEASER, after: "b".repeat(40) },
      ],
      refresh: { inMergeQueue: true },
      reviews: [{ id: 8, user: "jgoux", state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual(["dequeue:1", "disableAutoMerge:1"]);
    expect(entries[0]).toMatchObject({
      verdict: "tainted (push by jgoux)",
      actions: ["dequeue", "disable auto-merge"],
    });
  });

  test("withdraws automation and dismisses only the bot approval on a tainted PR a maintainer also approved", async () => {
    const { io, writes } = fakeIo([pr({ autoMergeEnabled: true })], {
      activity: () => [
        { type: "push", actor: "jgoux", after: SHA },
        { type: "branch_creation", actor: RELEASER, after: "b".repeat(40) },
      ],
      refresh: { inMergeQueue: true },
      reviews: [
        { id: 5, user: APPROVER_LOGIN, state: "APPROVED" },
        { id: 8, user: "jgoux", state: "APPROVED" },
      ],
    });

    const entries = await run(io);

    expect(writes).toEqual(["dequeue:1", "disableAutoMerge:1", "dismiss(5):1"]);
    expect(entries[0]?.actions).toEqual(["dequeue", "disable auto-merge", "dismiss approval"]);
  });

  test("withdraws automation and the bot approval from a `do not merge` PR a maintainer also approved", async () => {
    const { io, writes } = fakeIo([pr({ labels: ["do not merge"], autoMergeEnabled: true })], {
      refresh: { inMergeQueue: true },
      reviews: [
        { id: 5, user: APPROVER_LOGIN, state: "APPROVED" },
        { id: 8, user: "jgoux", state: "APPROVED" },
      ],
    });

    const entries = await run(io);

    expect(writes).toEqual(["dequeue:1", "disableAutoMerge:1", "dismiss(5):1"]);
    expect(entries[0]).toMatchObject({
      verdict: "held (labelled `do not merge`)",
      actions: ["dequeue", "disable auto-merge", "dismiss approval"],
    });
  });

  test("reports pending when the branch activity lookup fails and writes nothing", async () => {
    const { io, writes } = fakeIo([pr()], { failActivity: true });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]?.verdict).toBe(
      "pending (activity unavailable: activity unavailable upstream)",
    );
  });

  test.each([
    ["label added", { labels: ["do not merge"] }],
    ["head moved", { headSha: "d".repeat(40) }],
  ] as [string, Partial<BotPrState>][])(
    "does not approve or queue when the re-check before approving sees %s",
    async (_name, change) => {
      const { io, writes } = fakeIo([pr({ assignees: [APPROVER_LOGIN] })], {
        refreshSequence: [{}, change],
      });

      const entries = await run(io);

      expect(writes).toEqual([]);
      expect(entries[0]).toMatchObject({ verdict: "pending (changed during sweep)", actions: [] });
    },
  );

  test.each([
    ["label added", { labels: ["do not merge"] }],
    ["head moved", { headSha: "d".repeat(40) }],
  ] as [string, Partial<BotPrState>][])(
    "does not queue when the re-check before queueing sees %s",
    async (_name, change) => {
      const { io, writes } = fakeIo([pr({ assignees: [APPROVER_LOGIN] })], {
        refreshSequence: [{}, {}, change],
      });

      const entries = await run(io);

      expect(writes).toEqual(["approve:1"]);
      expect(entries[0]).toMatchObject({
        verdict: "pending (changed during sweep)",
        actions: ["approve"],
      });
    },
  );

  test.each([
    ["already in the merge queue", { inMergeQueue: true }],
    ["auto-merge already enabled", { autoMergeEnabled: true }],
  ] as [string, Partial<BotPrState>][])(
    "does not queue when the re-check before queueing shows the PR %s",
    async (_name, change) => {
      const { io, writes } = fakeIo([pr({ assignees: [APPROVER_LOGIN] })], {
        refreshSequence: [{}, {}, change],
      });

      const entries = await run(io);

      expect(writes).toEqual(["approve:1"]);
      expect(entries[0]).toMatchObject({ verdict: "trusted", actions: ["approve"] });
    },
  );

  test("holds a PR that became a draft after listing and revokes its approval", async () => {
    const { io, writes } = fakeIo([pr({ assignees: [APPROVER_LOGIN] })], {
      refresh: { draft: true },
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual(["dismiss(5):1"]);
    expect(entries[0]?.verdict).toBe("held (draft)");
  });

  test("holds a label added after listing and revokes approval, auto-merge and queue entry", async () => {
    const { io, writes } = fakeIo([pr({ assignees: [APPROVER_LOGIN] })], {
      refresh: { labels: ["Do Not Merge"], autoMergeEnabled: true, inMergeQueue: true },
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual(["dequeue:1", "disableAutoMerge:1", "dismiss(5):1"]);
    expect(entries[0]).toEqual({
      number: 1,
      headRef: "sync/api-package",
      verdict: "held (labelled `do not merge`)",
      actions: ["dequeue", "disable auto-merge", "dismiss approval"],
    });
  });

  test("dequeues a tainted PR that is in the merge queue", async () => {
    const { io, writes } = fakeIo([pr()], {
      activity: () => [
        { type: "push", actor: "jgoux", after: SHA },
        { type: "branch_creation", actor: RELEASER, after: "b".repeat(40) },
      ],
      refresh: { inMergeQueue: true },
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual(["dequeue:1", "dismiss(5):1"]);
    expect(entries[0]?.verdict).toBe("tainted (push by jgoux)");
  });

  test("keeps revoking and keeps completed actions when dismissing the approval fails", async () => {
    const { io, writes } = fakeIo([pr()], {
      activity: () => [
        { type: "push", actor: "jgoux", after: SHA },
        { type: "branch_creation", actor: RELEASER, after: "b".repeat(40) },
      ],
      refresh: { inMergeQueue: true, autoMergeEnabled: true },
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }],
      failCall: "dismiss(5)",
    });

    const entries = await run(io);

    expect(writes).toEqual(["dequeue:1", "disableAutoMerge:1"]);
    expect(entries[0]).toMatchObject({
      verdict: "error",
      actions: ["dequeue", "disable auto-merge"],
      guardViolation: false,
    });
    expect(entries[0]?.error).toBe(
      "Revocation incomplete for PR #1: dismiss approval: dismiss(5) failed",
    );
  });

  test("still dequeues and disables auto-merge on a tainted PR when listing reviews fails", async () => {
    const { io, writes } = fakeIo([pr()], {
      activity: () => [
        { type: "push", actor: "jgoux", after: SHA },
        { type: "branch_creation", actor: RELEASER, after: "b".repeat(40) },
      ],
      refresh: { inMergeQueue: true, autoMergeEnabled: true },
      failReviews: true,
    });

    const entries = await run(io);

    expect(writes).toEqual(["dequeue:1", "disableAutoMerge:1"]);
    expect(entries[0]).toMatchObject({
      verdict: "error",
      actions: ["dequeue", "disable auto-merge"],
      guardViolation: false,
    });
    expect(entries[0]?.error).toBe(
      "Revocation incomplete for PR #1: list reviews: reviews unavailable",
    );
  });

  test("leaves maintainer-created auto-merge and queue entry on a tainted PR but dismisses the bot approval", async () => {
    const { io, writes } = fakeIo([pr({ autoMergeEnabled: true })], {
      activity: () => [
        { type: "push", actor: "jgoux", after: SHA },
        { type: "branch_creation", actor: RELEASER, after: "b".repeat(40) },
      ],
      refresh: {
        inMergeQueue: true,
        autoMergeByBot: false,
        queuedByBot: false,
      },
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual(["dismiss(5):1"]);
    expect(entries[0]).toMatchObject({
      verdict: "tainted (push by jgoux)",
      actions: ["dismiss approval"],
    });
  });

  test("makes no writes on a trusted PR when listing reviews fails", async () => {
    const { io, writes } = fakeIo([pr()], { failReviews: true });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]).toMatchObject({
      verdict: "error",
      actions: [],
      error: "reviews unavailable",
    });
  });

  test("makes no writes when the refreshed head differs from the listed head", async () => {
    const { io, writes } = fakeIo([pr({ autoMergeEnabled: true })], {
      refresh: { headSha: "d".repeat(40) },
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]).toMatchObject({ verdict: "pending (head moved)", actions: [] });
  });

  test("makes no writes when the PR closed after listing", async () => {
    const { io, writes } = fakeIo([pr()], { refresh: { open: false } });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]?.verdict).toBe("pending (closed)");
  });

  test("does not queue a trusted PR that is already in the merge queue", async () => {
    const { io, writes } = fakeIo([pr({ assignees: [APPROVER_LOGIN] })], {
      refresh: { inMergeQueue: true },
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]).toMatchObject({ verdict: "trusted", actions: [] });
  });

  test("dry run reports intended actions without writing", async () => {
    const { io, writes } = fakeIo([pr()]);

    const entries = await run(io, true);

    expect(writes).toEqual([]);
    expect(entries[0]?.actions).toEqual(["would assign approver", "would approve", "would queue"]);
  });

  test("an io error on one pull request does not stop the others", async () => {
    const { io, writes } = fakeIo(
      [pr({ number: 1 }), pr({ number: 2, headRef: "slim-bump/realtime" })],
      { failOn: 1 },
    );

    const entries = await run(io);

    expect(entries[0]).toMatchObject({ number: 1, verdict: "error", error: "io failure on #1" });
    expect(entries[0]?.guardViolation).toBe(false);
    expect(entries[1]).toMatchObject({ number: 2, verdict: "trusted" });
    expect(writes).toContain("approve:2");
  });
});

describe("createBotPrIo call-site guard", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("approve and queue throw before any HTTP call for a deploy-shaped pull request", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const io = createBotPrIo({ repository: REPO, appToken: "app", approverToken: "approver" });

    await expect(io.approve(deployPr)).rejects.toBeInstanceOf(ApprovalGuardViolation);
    await expect(io.queue(deployPr)).rejects.toBeInstanceOf(ApprovalGuardViolation);
    expect(calls).toEqual([]);
  });

  test("queue falls back to enqueuePullRequest when enabling auto-merge returns errors", async () => {
    const mutations: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes("enablePullRequestAutoMerge")) {
        mutations.push("enablePullRequestAutoMerge");
        return new Response(JSON.stringify({ errors: [{ message: "auto-merge unavailable" }] }));
      }
      mutations.push("enqueuePullRequest");
      return new Response(JSON.stringify({ data: {} }));
    }) as unknown as typeof fetch;
    const io = createBotPrIo({ repository: REPO, appToken: "app", approverToken: "approver" });

    await io.queue(pr());

    expect(mutations).toEqual(["enablePullRequestAutoMerge", "enqueuePullRequest"]);
  });

  test("queue throws naming both failures when auto-merge and enqueue both fail", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "nope" }] }))) as unknown as typeof fetch;
    const io = createBotPrIo({ repository: REPO, appToken: "app", approverToken: "approver" });

    await expect(io.queue(pr())).rejects.toThrow(/auto-merge failed.*enqueue failed/);
  });

  test("refresh treats the releaser app, with or without [bot], as bot-created automation", async () => {
    const respond = (autoMergeLogin: string, enqueuerLogin: string) =>
      (async () =>
        new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  state: "OPEN",
                  isDraft: false,
                  baseRefName: "develop",
                  headRefName: "sync/api-package",
                  headRefOid: SHA,
                  labels: { nodes: [] },
                  autoMergeRequest: { enabledBy: { login: autoMergeLogin } },
                  isInMergeQueue: true,
                  mergeQueueEntry: { enqueuer: { login: enqueuerLogin } },
                },
              },
            },
          }),
        )) as unknown as typeof fetch;
    const io = createBotPrIo({ repository: REPO, appToken: "app", approverToken: "approver" });

    globalThis.fetch = respond("supabase-cli-releaser", "supabase-cli-releaser[bot]");
    expect(await io.refresh(pr())).toMatchObject({
      autoMergeEnabled: true,
      inMergeQueue: true,
      autoMergeByBot: true,
      queuedByBot: true,
    });

    globalThis.fetch = respond("jgoux", "jgoux");
    expect(await io.refresh(pr())).toMatchObject({
      autoMergeEnabled: true,
      inMergeQueue: true,
      autoMergeByBot: false,
      queuedByBot: false,
    });
  });

  test("approve for an eligible pull request posts the review pinned to the head", async () => {
    const requests: { url: string; body: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body) });
      return new Response("{}");
    }) as unknown as typeof fetch;
    const io = createBotPrIo({ repository: REPO, appToken: "app", approverToken: "approver" });

    await io.approve(pr());

    expect(requests).toEqual([
      {
        url: `https://api.github.com/repos/${REPO}/pulls/1/reviews`,
        body: JSON.stringify({ event: "APPROVE", commit_id: SHA }),
      },
    ]);
  });
});

describe("renderSummary", () => {
  const entry = (overrides: Partial<BotPrSweepEntry>): BotPrSweepEntry => ({
    number: 1,
    headRef: "sync/api-package",
    verdict: "trusted",
    actions: [],
    ...overrides,
  });

  test("renders a pipe in the branch and a newline in the error as one escaped row", () => {
    const summary = renderSummary(
      [entry({ headRef: "sync/a|b", verdict: "error", error: "first line\nsecond | line" })],
      false,
    );

    const rows = summary.split("\n").filter((line) => line.startsWith("| #"));
    expect(rows).toEqual(["| #1 | `sync/a\\|b` | error: first line second \\| line | none |"]);
    expect(summary.split("\n")).toHaveLength(5);
  });

  test("labels a guard violation entry", () => {
    const summary = renderSummary(
      [entry({ verdict: "error", error: "base is `main`", guardViolation: true })],
      false,
    );

    expect(summary).toContain("| guard violation: base is `main` |");
  });
});
