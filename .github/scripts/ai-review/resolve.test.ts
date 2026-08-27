import { describe, expect, test } from "bun:test";
import {
  AI_REVIEW_MARKER,
  type MarkedBody,
  type PrDetails,
  resolveDecision,
  type ResolveIo,
} from "./resolve.ts";

const REPO = "supabase/cli";

function makePr(overrides: Partial<PrDetails> = {}): PrDetails {
  return {
    number: 42,
    state: "open",
    draft: false,
    authorIsBot: false,
    headRepoFullName: REPO,
    baseRepoFullName: REPO,
    additions: 10,
    deletions: 5,
    changedFiles: 3,
    ...overrides,
  };
}

function makeIo(
  pr: PrDetails,
  opts: {
    reviews?: MarkedBody[];
    comments?: MarkedBody[];
    permissionByLogin?: Record<string, string | undefined>;
  } = {},
): {
  io: ResolveIo;
  reactions: number[];
  permissionLookups: string[];
  calls: { listReviews: number; listIssueComments: number };
} {
  const reactions: number[] = [];
  const permissionLookups: string[] = [];
  const calls = { listReviews: 0, listIssueComments: 0 };
  const io: ResolveIo = {
    fetchPr: () => Promise.resolve(pr),
    listReviews: () => {
      calls.listReviews++;
      return Promise.resolve(opts.reviews ?? []);
    },
    listIssueComments: () => {
      calls.listIssueComments++;
      return Promise.resolve(opts.comments ?? []);
    },
    fetchPermission: (login) => {
      permissionLookups.push(login);
      return Promise.resolve(opts.permissionByLogin?.[login]);
    },
    reactToComment: (commentId) => {
      reactions.push(commentId);
      return Promise.resolve();
    },
  };
  return { io, reactions, permissionLookups, calls };
}

describe("resolveDecision: closed PR", () => {
  test.each([
    ["workflow_dispatch", "manual"],
    ["pull_request", "auto"],
  ] as const)(
    "skips a closed PR for %s events regardless of trigger",
    async (eventName, expectedTrigger) => {
      const pr = makePr({ state: "closed" });
      const { io } = makeIo(pr);
      const result = await resolveDecision({ eventName, prNumber: pr.number }, io);
      expect(result).toEqual({
        shouldRun: false,
        skipReason: "PR #42 is closed.",
        mode: "review",
        trigger: expectedTrigger,
      });
    },
  );
});

describe("resolveDecision: auto trigger (pull_request) skip conditions", () => {
  test("skips a draft PR", async () => {
    const pr = makePr({ draft: true });
    const { io } = makeIo(pr);
    const result = await resolveDecision({ eventName: "pull_request", prNumber: pr.number }, io);
    expect(result).toEqual({
      shouldRun: false,
      skipReason: "PR is a draft.",
      mode: "review",
      trigger: "auto",
    });
  });

  test("skips a bot-authored PR", async () => {
    const pr = makePr({ authorIsBot: true });
    const { io } = makeIo(pr);
    const result = await resolveDecision({ eventName: "pull_request", prNumber: pr.number }, io);
    expect(result).toEqual({
      shouldRun: false,
      skipReason: "PR author is a bot.",
      mode: "review",
      trigger: "auto",
    });
  });

  test("skips a PR from a fork", async () => {
    const pr = makePr({ headRepoFullName: "someone/fork" });
    const { io } = makeIo(pr);
    const result = await resolveDecision({ eventName: "pull_request", prNumber: pr.number }, io);
    expect(result).toEqual({
      shouldRun: false,
      skipReason: "PR is from a fork; ask a maintainer to comment /ai-review instead.",
      mode: "review",
      trigger: "auto",
    });
  });

  test("skips a PR that already carries the marker in a prior review", async () => {
    const pr = makePr();
    const { io } = makeIo(pr, { reviews: [{ body: `Nice work.\n${AI_REVIEW_MARKER}` }] });
    const result = await resolveDecision({ eventName: "pull_request", prNumber: pr.number }, io);
    expect(result.shouldRun).toBe(false);
    expect(result.skipReason).toBe(
      "PR already received an AI review; comment /ai-review to request another.",
    );
  });

  test("skips a PR that already carries the marker in a prior issue comment", async () => {
    const pr = makePr();
    const { io } = makeIo(pr, { comments: [{ body: `Notice\n${AI_REVIEW_MARKER}` }] });
    const result = await resolveDecision({ eventName: "pull_request", prNumber: pr.number }, io);
    expect(result.shouldRun).toBe(false);
    expect(result.skipReason).toBe(
      "PR already received an AI review; comment /ai-review to request another.",
    );
  });

  test("proceeds when no prior review or comment carries the marker", async () => {
    const pr = makePr();
    const { io } = makeIo(pr, {
      reviews: [{ body: "unrelated review" }],
      comments: [{ body: "unrelated comment" }],
    });
    const result = await resolveDecision({ eventName: "pull_request", prNumber: pr.number }, io);
    expect(result.shouldRun).toBe(true);
    expect(result.mode).toBe("review");
    expect(result.skipReason).toBeUndefined();
  });
});

describe("resolveDecision: manual trigger bypasses auto-only skips", () => {
  test.each([
    ["a draft PR", { draft: true }],
    ["a bot-authored PR", { authorIsBot: true }],
    ["a PR from a fork", { headRepoFullName: "someone/fork" }],
  ])("workflow_dispatch runs %s", async (_label, overrides) => {
    const pr = makePr(overrides);
    const { io } = makeIo(pr);
    const result = await resolveDecision(
      { eventName: "workflow_dispatch", prNumber: pr.number },
      io,
    );
    expect(result.shouldRun).toBe(true);
    expect(result.mode).toBe("review");
    expect(result.trigger).toBe("manual");
  });

  test("workflow_dispatch bypasses the already-reviewed dedup guard without even checking it", async () => {
    const pr = makePr();
    const { io, calls } = makeIo(pr, { reviews: [{ body: AI_REVIEW_MARKER }] });
    const result = await resolveDecision(
      { eventName: "workflow_dispatch", prNumber: pr.number },
      io,
    );
    expect(result.shouldRun).toBe(true);
    expect(calls.listReviews).toBe(0);
    expect(calls.listIssueComments).toBe(0);
  });
});

describe("resolveDecision: size guard boundaries", () => {
  test.each([
    [
      "combined additions+deletions at exactly 8000",
      { additions: 4000, deletions: 4000, changedFiles: 10 },
      "review",
    ],
    [
      "combined additions+deletions just under (7999)",
      { additions: 4000, deletions: 3999, changedFiles: 10 },
      "review",
    ],
    [
      "combined additions+deletions just over (8001)",
      { additions: 4000, deletions: 4001, changedFiles: 10 },
      "too-large",
    ],
    ["changed files at exactly 120", { additions: 10, deletions: 10, changedFiles: 120 }, "review"],
    [
      "changed files just under (119)",
      { additions: 10, deletions: 10, changedFiles: 119 },
      "review",
    ],
    [
      "changed files just over (121)",
      { additions: 10, deletions: 10, changedFiles: 121 },
      "too-large",
    ],
  ] as const)("%s -> mode %s", async (_label, overrides, expectedMode) => {
    const pr = makePr(overrides);
    const { io } = makeIo(pr);
    const result = await resolveDecision(
      { eventName: "workflow_dispatch", prNumber: pr.number },
      io,
    );
    expect(result.shouldRun).toBe(true);
    expect(result.mode).toBe(expectedMode);
    if (expectedMode === "too-large") {
      expect(result.skipReason).toContain("too large for a full AI review");
    } else {
      expect(result.skipReason).toBeUndefined();
    }
  });

  test("still applies to a manually-authorized PR that would otherwise be auto-skipped", async () => {
    const pr = makePr({ draft: true, additions: 8000, deletions: 1, changedFiles: 200 });
    const { io } = makeIo(pr);
    const result = await resolveDecision(
      { eventName: "workflow_dispatch", prNumber: pr.number },
      io,
    );
    expect(result.shouldRun).toBe(true);
    expect(result.mode).toBe("too-large");
  });
});

describe("resolveDecision: issue_comment authorization", () => {
  test("throws when the issue_comment event carries no comment details", async () => {
    const pr = makePr();
    const { io } = makeIo(pr);
    await expect(
      resolveDecision({ eventName: "issue_comment", prNumber: pr.number }, io),
    ).rejects.toThrow("issue_comment trigger requires comment details");
  });

  test.each(["OWNER", "MEMBER", "COLLABORATOR"])(
    "association %s is authorized without a permission lookup",
    async (authorAssociation) => {
      const pr = makePr();
      const { io, permissionLookups, reactions } = makeIo(pr);
      const result = await resolveDecision(
        {
          eventName: "issue_comment",
          prNumber: pr.number,
          comment: { id: 555, authorLogin: "maintainer", authorAssociation },
        },
        io,
      );
      expect(result.shouldRun).toBe(true);
      expect(permissionLookups).toEqual([]);
      expect(reactions).toEqual([555]);
    },
  );

  test.each([
    ["NONE", "admin", true],
    ["NONE", "write", true],
    ["NONE", "read", false],
    ["NONE", "none", false],
    ["CONTRIBUTOR", "admin", true],
    ["CONTRIBUTOR", "write", true],
    ["CONTRIBUTOR", "read", false],
    ["CONTRIBUTOR", "none", false],
  ])(
    "association %s falls back to permission lookup: %s -> authorized=%s",
    async (authorAssociation, permission, expectedAuthorized) => {
      const pr = makePr();
      const { io, permissionLookups, reactions } = makeIo(pr, {
        permissionByLogin: { commenter: permission },
      });
      const result = await resolveDecision(
        {
          eventName: "issue_comment",
          prNumber: pr.number,
          comment: { id: 9, authorLogin: "commenter", authorAssociation },
        },
        io,
      );
      expect(result.shouldRun).toBe(expectedAuthorized);
      expect(permissionLookups).toEqual(["commenter"]);
      expect(reactions).toEqual(expectedAuthorized ? [9] : []);
    },
  );

  test("an unresolvable permission (undefined) is treated as unauthorized", async () => {
    const pr = makePr();
    const { io, reactions } = makeIo(pr);
    const result = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: { id: 3, authorLogin: "rando", authorAssociation: "NONE" },
      },
      io,
    );
    expect(result.shouldRun).toBe(false);
    expect(reactions).toEqual([]);
  });

  test("unauthorized commenter gets a descriptive skip reason and no reaction", async () => {
    const pr = makePr();
    const { io, reactions } = makeIo(pr);
    const result = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: { id: 1, authorLogin: "rando", authorAssociation: "NONE" },
      },
      io,
    );
    expect(result).toEqual({
      shouldRun: false,
      skipReason:
        "Commenter @rando is not an internal maintainer " +
        "(author_association=NONE, permission=n/a); only maintainers can trigger /ai-review.",
      mode: "review",
      trigger: "manual",
    });
    expect(reactions).toEqual([]);
  });

  test("authorized comment triggers the eyes reaction exactly once", async () => {
    const pr = makePr();
    const { io, reactions } = makeIo(pr);
    await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: { id: 777, authorLogin: "owner-user", authorAssociation: "OWNER" },
      },
      io,
    );
    expect(reactions).toEqual([777]);
    expect(reactions).toHaveLength(1);
  });

  test("authorized comment bypasses the dedup guard like other manual triggers", async () => {
    const pr = makePr();
    const { io, calls } = makeIo(pr, { reviews: [{ body: AI_REVIEW_MARKER }] });
    const result = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: { id: 2, authorLogin: "owner-user", authorAssociation: "OWNER" },
      },
      io,
    );
    expect(result.shouldRun).toBe(true);
    expect(calls.listReviews).toBe(0);
  });
});

describe("resolveDecision: trigger classification per event shape", () => {
  test("workflow_dispatch is a manual trigger", async () => {
    const pr = makePr();
    const { io } = makeIo(pr);
    const result = await resolveDecision(
      { eventName: "workflow_dispatch", prNumber: pr.number },
      io,
    );
    expect(result.trigger).toBe("manual");
  });

  test("issue_comment is a manual trigger", async () => {
    const pr = makePr();
    const { io } = makeIo(pr);
    const result = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: { id: 1, authorLogin: "maint", authorAssociation: "OWNER" },
      },
      io,
    );
    expect(result.trigger).toBe("manual");
  });

  test("pull_request is an auto trigger", async () => {
    const pr = makePr();
    const { io } = makeIo(pr);
    const result = await resolveDecision({ eventName: "pull_request", prNumber: pr.number }, io);
    expect(result.trigger).toBe("auto");
  });
});
