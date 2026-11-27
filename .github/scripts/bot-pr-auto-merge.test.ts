import { afterEach, describe, expect, test } from "bun:test";

import {
  APPROVER_LOGIN,
  ApprovalGuardViolation,
  type ActivityEvent,
  type BotPr,
  type BotPrIo,
  type PrReview,
  assertApprovable,
  createBotPrIo,
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
  } = {},
): Fake {
  const writes: string[] = [];
  const record = (name: string, target: BotPr) => {
    if (target.number === options.failOn) {
      throw new Error(`io failure on #${target.number}`);
    }
    writes.push(`${name}:${target.number}`);
  };
  const io: BotPrIo = {
    listPrs: async () => prs,
    listBranchActivity: async (headRef) =>
      options.activity?.(headRef) ??
      cleanHistory(headRef.startsWith("dependabot/") ? DEPENDABOT : RELEASER),
    listReviews: async () => options.reviews ?? [],
    approve: async (target) => {
      record("approve", target);
    },
    enableAutoMerge: async (target) => {
      record("enableAutoMerge", target);
    },
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

  test.each(["sync/api-package", "slim-bump/realtime", "dependabot/npm_and_yarn/x"])(
    "allows head %s",
    (headRef) => {
      expect(() => assertApprovable({ ...ok, headRef })).not.toThrow();
    },
  );
});

describe("sweepBotPrs deploy protection", () => {
  test("ignores a production deploy pull request and writes nothing", async () => {
    const { io, writes } = fakeIo([deployPr]);

    expect(await run(io)).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("refuses a deploy pull request that bypasses the base filter and reports a guard violation", async () => {
    const bypassing = pr({
      number: 7771,
      baseRef: "develop",
      headRef: "sync/api-package",
      labels: ["do not merge"],
    });
    const { io, writes } = fakeIo([bypassing]);

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      number: 7771,
      verdict: "error",
      actions: [],
      guardViolation: true,
    });
    expect(entries[0]?.error).toContain("do not merge");
  });

  test("never auto-merges a deploy-shaped pull request even when its head family and author match", async () => {
    const shaped = pr({ number: 7771, headRef: "slim-bump/x", labels: ["do not merge"] });
    const { io, writes } = fakeIo([shaped]);

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]?.guardViolation).toBe(true);
  });
});

describe("sweepBotPrs eligibility", () => {
  test.each([
    ["dependabot branch opened by the releaser", { headRef: "dependabot/npm_and_yarn/x" }],
    ["releaser branch opened by dependabot", { authorLogin: DEPENDABOT }],
    ["fork head", { headRepo: "someone/cli" }],
    ["deleted fork head", { headRepo: null }],
    ["draft", { draft: true }],
    ["unknown branch family", { headRef: "feature/x" }],
    ["human author on a bot branch", { authorLogin: "jgoux" }],
  ] as [string, Partial<BotPr>][])("ignores a %s", async (_name, overrides) => {
    const { io, writes } = fakeIo([pr(overrides)]);

    expect(await run(io)).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("sweepBotPrs provenance", () => {
  test("approves the head and enables auto-merge for a bot-only branch", async () => {
    const { io, writes } = fakeIo([pr()]);

    const entries = await run(io);

    expect(writes).toEqual(["assign:1", "approve:1", "enableAutoMerge:1"]);
    expect(entries).toEqual([
      {
        number: 1,
        headRef: "sync/api-package",
        verdict: "trusted",
        actions: ["assign approver", "approve", "enable auto-merge"],
      },
    ]);
  });

  test("approves a dependabot branch pushed only by dependabot", async () => {
    const { io, writes } = fakeIo([
      pr({ headRef: "dependabot/npm_and_yarn/x", authorLogin: DEPENDABOT }),
    ]);

    await run(io);

    expect(writes).toContain("approve:1");
    expect(writes).toContain("enableAutoMerge:1");
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

    expect(writes).toEqual(["dismiss(99):1", "disableAutoMerge:1"]);
    expect(entries[0]?.actions).toEqual(["dismiss approval", "disable auto-merge"]);
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
  test("makes no writes when already assigned, approved and queued", async () => {
    const { io, writes } = fakeIo([pr({ autoMergeEnabled: true, assignees: [APPROVER_LOGIN] })], {
      reviews: [{ id: 5, user: APPROVER_LOGIN, state: "APPROVED" }],
    });

    const entries = await run(io);

    expect(writes).toEqual([]);
    expect(entries[0]).toMatchObject({ verdict: "trusted", actions: [] });
  });

  test("re-approves when the latest approver review was dismissed", async () => {
    const { io, writes } = fakeIo([pr({ autoMergeEnabled: true, assignees: [APPROVER_LOGIN] })], {
      reviews: [
        { id: 5, user: APPROVER_LOGIN, state: "APPROVED" },
        { id: 6, user: APPROVER_LOGIN, state: "DISMISSED" },
      ],
    });

    await run(io);

    expect(writes).toEqual(["approve:1"]);
  });

  test("dry run reports intended actions without writing", async () => {
    const { io, writes } = fakeIo([pr()]);

    const entries = await run(io, true);

    expect(writes).toEqual([]);
    expect(entries[0]?.actions).toEqual([
      "would assign approver",
      "would approve",
      "would enable auto-merge",
    ]);
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

  test("approve and enableAutoMerge throw before any HTTP call for a deploy-shaped pull request", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const io = createBotPrIo({ repository: REPO, appToken: "app", approverToken: "approver" });

    await expect(io.approve(deployPr)).rejects.toBeInstanceOf(ApprovalGuardViolation);
    await expect(io.enableAutoMerge(deployPr)).rejects.toBeInstanceOf(ApprovalGuardViolation);
    expect(calls).toEqual([]);
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
