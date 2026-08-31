import { describe, expect, test } from "bun:test";
import {
  AI_REVIEW_MARKER,
  type MarkedBody,
  type PrDetails,
  resolveDecision,
  type ResolveIo,
  type TriggeringComment,
} from "./resolve.ts";

const REPO = "supabase/cli";
const WORKFLOW_BOT_LOGIN = "github-actions[bot]";

function makePr(overrides: Partial<PrDetails> = {}): PrDetails {
  return {
    number: 42,
    state: "open",
    draft: false,
    authorIsBot: false,
    headRepoFullName: REPO,
    baseRepoFullName: REPO,
    ...overrides,
  };
}

/** A marker-bearing entry posted by the workflow bot — the only kind that
 * should ever suppress the auto dedup guard. */
function botMarkedBody(body: string): MarkedBody {
  return { body, authorLogin: WORKFLOW_BOT_LOGIN };
}

function makeComment(overrides: Partial<TriggeringComment> = {}): TriggeringComment {
  return {
    id: 1,
    authorLogin: "commenter",
    authorAssociation: "NONE",
    body: "/ai-review",
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
      trigger: "auto",
    });
  });

  test("skips a PR that already carries the marker in a prior review from the workflow bot", async () => {
    const pr = makePr();
    const { io } = makeIo(pr, { reviews: [botMarkedBody(`Nice work.\n${AI_REVIEW_MARKER}`)] });
    const result = await resolveDecision({ eventName: "pull_request", prNumber: pr.number }, io);
    expect(result.shouldRun).toBe(false);
    expect(result.skipReason).toBe(
      "PR already received an AI review; comment /ai-review to request another.",
    );
  });

  test("skips a PR that already carries the marker in a prior issue comment from the workflow bot", async () => {
    const pr = makePr();
    const { io } = makeIo(pr, { comments: [botMarkedBody(`Notice\n${AI_REVIEW_MARKER}`)] });
    const result = await resolveDecision({ eventName: "pull_request", prNumber: pr.number }, io);
    expect(result.shouldRun).toBe(false);
    expect(result.skipReason).toBe(
      "PR already received an AI review; comment /ai-review to request another.",
    );
  });

  test("a non-bot review or comment containing the marker does not suppress the review", async () => {
    const pr = makePr();
    const { io } = makeIo(pr, {
      reviews: [{ body: `Fake review\n${AI_REVIEW_MARKER}`, authorLogin: "not-the-workflow-bot" }],
      comments: [{ body: `Fake notice\n${AI_REVIEW_MARKER}`, authorLogin: "a-random-user" }],
    });
    const result = await resolveDecision({ eventName: "pull_request", prNumber: pr.number }, io);
    expect(result.shouldRun).toBe(true);
    expect(result.skipReason).toBeUndefined();
  });

  test("proceeds when no prior review or comment carries the marker", async () => {
    const pr = makePr();
    const { io } = makeIo(pr, {
      reviews: [{ body: "unrelated review", authorLogin: WORKFLOW_BOT_LOGIN }],
      comments: [{ body: "unrelated comment", authorLogin: WORKFLOW_BOT_LOGIN }],
    });
    const result = await resolveDecision({ eventName: "pull_request", prNumber: pr.number }, io);
    expect(result.shouldRun).toBe(true);
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
    expect(result.trigger).toBe("manual");
  });

  test("workflow_dispatch bypasses the already-reviewed dedup guard without even checking it", async () => {
    const pr = makePr();
    const { io, calls } = makeIo(pr, { reviews: [botMarkedBody(AI_REVIEW_MARKER)] });
    const result = await resolveDecision(
      { eventName: "workflow_dispatch", prNumber: pr.number },
      io,
    );
    expect(result.shouldRun).toBe(true);
    expect(calls.listReviews).toBe(0);
    expect(calls.listIssueComments).toBe(0);
  });
});

describe("resolveDecision: issue_comment command matching", () => {
  test("throws when the issue_comment event carries no comment details", async () => {
    const pr = makePr();
    const { io } = makeIo(pr);
    await expect(
      resolveDecision({ eventName: "issue_comment", prNumber: pr.number }, io),
    ).rejects.toThrow("issue_comment trigger requires comment details");
  });

  test.each(["/ai-reviewers", "/ai-review-please", "not a command", "/AI-REVIEW", "ai-review"])(
    "rejects a comment whose first line isn't exactly /ai-review: %s",
    async (body) => {
      const pr = makePr();
      const { io, permissionLookups, reactions } = makeIo(pr, {
        permissionByLogin: { commenter: "admin" },
      });
      const result = await resolveDecision(
        {
          eventName: "issue_comment",
          prNumber: pr.number,
          comment: makeComment({ body, authorAssociation: "OWNER" }),
        },
        io,
      );
      expect(result.shouldRun).toBe(false);
      expect(permissionLookups).toEqual([]);
      expect(reactions).toEqual([]);
    },
  );

  test("accepts /ai-review as the exact first line with trailing message text", async () => {
    const pr = makePr();
    const { io } = makeIo(pr, { permissionByLogin: { commenter: "admin" } });
    const result = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: makeComment({ body: "/ai-review\n\nplease take another look" }),
      },
      io,
    );
    expect(result.shouldRun).toBe(true);
  });

  test("trims leading/trailing whitespace on the first line before comparing", async () => {
    const pr = makePr();
    const { io } = makeIo(pr, { permissionByLogin: { commenter: "admin" } });
    const result = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: makeComment({ body: "  /ai-review  " }),
      },
      io,
    );
    expect(result.shouldRun).toBe(true);
  });
});

describe("resolveDecision: issue_comment authorization", () => {
  test("OWNER is always authorized, even when the permission lookup can't resolve", async () => {
    const pr = makePr();
    const { io, permissionLookups, reactions } = makeIo(pr);
    const result = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: makeComment({ id: 555, authorLogin: "maintainer", authorAssociation: "OWNER" }),
      },
      io,
    );
    expect(result.shouldRun).toBe(true);
    // The effective permission is always resolved (only the write-permission
    // requirement short-circuits for OWNER), so the lookup still happens.
    expect(permissionLookups).toEqual(["maintainer"]);
    expect(reactions).toEqual([555]);
  });

  test.each([
    ["MEMBER", "admin", true],
    ["MEMBER", "write", true],
    ["MEMBER", "read", false],
    ["MEMBER", "none", false],
    ["COLLABORATOR", "admin", true],
    ["COLLABORATOR", "write", true],
    ["COLLABORATOR", "read", false],
    ["COLLABORATOR", "none", false],
    ["NONE", "admin", true],
    ["NONE", "write", true],
    ["NONE", "read", false],
    ["NONE", "none", false],
    ["CONTRIBUTOR", "admin", true],
    ["CONTRIBUTOR", "write", true],
    ["CONTRIBUTOR", "read", false],
    ["CONTRIBUTOR", "none", false],
  ])(
    "association %s requires a passing permission lookup: %s -> authorized=%s",
    async (authorAssociation, permission, expectedAuthorized) => {
      const pr = makePr();
      const { io, permissionLookups, reactions } = makeIo(pr, {
        permissionByLogin: { commenter: permission },
      });
      const result = await resolveDecision(
        {
          eventName: "issue_comment",
          prNumber: pr.number,
          comment: makeComment({ id: 9, authorLogin: "commenter", authorAssociation }),
        },
        io,
      );
      expect(result.shouldRun).toBe(expectedAuthorized);
      expect(permissionLookups).toEqual(["commenter"]);
      expect(reactions).toEqual(expectedAuthorized ? [9] : []);
    },
  );

  test("MEMBER and COLLABORATOR are no longer authorized without a passing permission lookup", async () => {
    const pr = makePr();
    const { io: memberIo } = makeIo(pr, { permissionByLogin: { commenter: undefined } });
    const memberResult = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: makeComment({ authorLogin: "commenter", authorAssociation: "MEMBER" }),
      },
      memberIo,
    );
    expect(memberResult.shouldRun).toBe(false);

    const { io: collaboratorIo } = makeIo(pr, { permissionByLogin: { commenter: "read" } });
    const collaboratorResult = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: makeComment({ authorLogin: "commenter", authorAssociation: "COLLABORATOR" }),
      },
      collaboratorIo,
    );
    expect(collaboratorResult.shouldRun).toBe(false);
  });

  test("an unresolvable permission (undefined) is treated as unauthorized", async () => {
    const pr = makePr();
    const { io, reactions } = makeIo(pr);
    const result = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: makeComment({ id: 3, authorLogin: "rando", authorAssociation: "NONE" }),
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
        comment: makeComment({ id: 1, authorLogin: "rando", authorAssociation: "NONE" }),
      },
      io,
    );
    expect(result).toEqual({
      shouldRun: false,
      skipReason:
        "Commenter @rando is not authorized to run /ai-review " +
        "(author_association=NONE, permission=n/a); requires repository write access " +
        "(or being the repository owner).",
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
        comment: makeComment({ id: 777, authorLogin: "owner-user", authorAssociation: "OWNER" }),
      },
      io,
    );
    expect(reactions).toEqual([777]);
    expect(reactions).toHaveLength(1);
  });

  test("a reaction failure is best-effort and does not fail an otherwise-authorized run", async () => {
    const pr = makePr();
    const io: ResolveIo = {
      fetchPr: () => Promise.resolve(pr),
      listReviews: () => Promise.resolve([]),
      listIssueComments: () => Promise.resolve([]),
      fetchPermission: () => Promise.resolve("admin"),
      reactToComment: () => Promise.reject(new Error("403 Forbidden")),
    };
    const result = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: makeComment({ authorLogin: "commenter", authorAssociation: "NONE" }),
      },
      io,
    );
    expect(result.shouldRun).toBe(true);
  });

  test("authorized comment bypasses the dedup guard like other manual triggers", async () => {
    const pr = makePr();
    const { io, calls } = makeIo(pr, {
      reviews: [botMarkedBody(AI_REVIEW_MARKER)],
      permissionByLogin: { "owner-user": "admin" },
    });
    const result = await resolveDecision(
      {
        eventName: "issue_comment",
        prNumber: pr.number,
        comment: makeComment({ id: 2, authorLogin: "owner-user", authorAssociation: "OWNER" }),
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
        comment: makeComment({ authorLogin: "maint", authorAssociation: "OWNER" }),
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
