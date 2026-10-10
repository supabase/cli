import { describe, expect, test } from "bun:test";

import { REQUIRED_CHECKS } from "./fast-forward.ts";
import { RELEASE_BOT_LOGIN } from "./promotion-shared.ts";
import { type SettleCheck, type SettleState, decideSettle } from "./sync-settle.ts";

const pair = { source: "develop", target: "next" };
const head = "a".repeat(40);
const resolvedAt = Date.parse("2026-10-10T10:00:00Z");
const hours = (count: number) => new Date(resolvedAt + count * 3_600_000).toISOString();

function check(name: string, overrides: Partial<SettleCheck> = {}): SettleCheck {
  return {
    name,
    status: "completed",
    conclusion: "success",
    runId: 1,
    jobId: 10,
    attempt: 1,
    ...overrides,
  };
}

const finding = { threadId: "T1", commentId: 11, path: "a.ts", line: 3, body: "Lost a flag." };
const bot = (body: string, createdAt = hours(0)) => ({ login: RELEASE_BOT_LOGIN, body, createdAt });

/** A settled head: every required check green, branch policy red by design, reviewed an hour after resolving. */
function state(overrides: Partial<SettleState> = {}): SettleState {
  return {
    pull: { number: 7, draft: false, headSha: head },
    syncRunning: false,
    comments: [bot("<!-- sync-resolution -->\nResolved.")],
    checks: [
      ...REQUIRED_CHECKS.map((name) => check(name)),
      check("Require fast-forward", { conclusion: "failure" }),
    ],
    aiReview: { submittedAt: hours(1), body: "<!-- supabase-ai-review -->\nOne finding." },
    findings: [],
    now: resolvedAt + 3 * 3_600_000,
    ...overrides,
  };
}

const failingQuality = (attempt: number) => [
  ...REQUIRED_CHECKS.filter((name) => name !== "Check code quality").map((name) => check(name)),
  check("Check code quality", { conclusion: "failure", runId: 5, jobId: 50, attempt }),
];

describe("decideSettle", () => {
  test.each([
    ["no sync pull request is open", { pull: undefined }],
    ["the pull request is a draft", { pull: { number: 7, draft: true, headSha: head } }],
    ["a sync run owns the branch", { syncRunning: true }],
    [
      "a required check is still running",
      {
        checks: REQUIRED_CHECKS.map((name, index) =>
          index === 0 ? check(name, { status: "in_progress", conclusion: null }) : check(name),
        ),
      },
    ],
    [
      "the AI review is pending within its wait",
      { aiReview: undefined, now: resolvedAt + 3_600_000 },
    ],
    [
      "this head was already handed over",
      { comments: [bot("<!-- sync-resolution -->"), bot(`<!-- sync-escalated head=${head} -->`)] },
    ],
  ] as const)("waits when %s", (_, overrides) => {
    expect(decideSettle(state(overrides as Partial<SettleState>), pair).action).toBe("wait");
  });

  test("is ready when only the branch-policy check fails and no finding is open", () => {
    expect(decideSettle(state(), pair)).toEqual({ action: "ready" });
  });

  test("re-runs a failed job once before repairing", () => {
    expect(decideSettle(state({ checks: failingQuality(1) }), pair)).toEqual({
      action: "rerun",
      runIds: [5],
    });
  });

  test("plans a repair with the twice-failed jobs, the open findings, and the review summary", () => {
    const decision = decideSettle(state({ checks: failingQuality(2), findings: [finding] }), pair);

    expect(decision).toEqual({
      action: "repair",
      plan: {
        source: "develop",
        target: "next",
        pullRequest: 7,
        head,
        round: 1,
        failures: [{ name: "Check code quality", runId: 5, jobId: 50, conclusion: "failure" }],
        findings: [finding],
        reviewBody: "<!-- supabase-ai-review -->\nOne finding.",
      },
    });
  });

  test("repairs without the AI review once its wait is over", () => {
    const decision = decideSettle(
      state({ aiReview: undefined, findings: [], checks: failingQuality(2) }),
      pair,
    );

    expect(decision).toMatchObject({ action: "repair", plan: { round: 1, reviewBody: null } });
  });

  test("hands over after two rounds, even when a round quotes a resolution marker", () => {
    const rounds = [
      bot("<!-- sync-resolution -->"),
      bot("<!-- sync-repair round=1 head=b -->", hours(2)),
      bot(
        "<!-- sync-repair round=2 head=c -->\nAgent text quoting <!-- sync-resolution -->",
        hours(3),
      ),
    ];

    const decision = decideSettle(state({ comments: rounds, checks: failingQuality(2) }), pair);

    expect(decision).toMatchObject({ action: "escalate" });
  });

  test("hands over when a round on this head changed nothing and jobs still fail", () => {
    const comments = [
      bot("<!-- sync-resolution -->"),
      bot(`<!-- sync-repair round=1 head=${head} -->`, hours(2)),
    ];

    const decision = decideSettle(state({ comments, checks: failingQuality(2) }), pair);

    expect(decision).toMatchObject({ action: "escalate" });
  });

  test("counts every round on a pull request a maintainer resolved by hand", () => {
    const comments = [
      bot("<!-- sync-repair round=1 head=b -->", hours(-2)),
      bot("<!-- sync-repair round=2 head=c -->", hours(-1)),
    ];

    const decision = decideSettle(state({ comments, checks: failingQuality(2) }), pair);

    expect(decision).toMatchObject({ action: "escalate" });
  });

  test("counts rounds only since the latest resolution", () => {
    const comments = [
      bot("<!-- sync-resolution -->", hours(-5)),
      bot("<!-- sync-repair round=1 head=b -->", hours(-4)),
      bot("<!-- sync-repair round=2 head=c -->", hours(-3)),
      bot("<!-- sync-resolution -->"),
    ];

    const decision = decideSettle(state({ comments, checks: failingQuality(2) }), pair);

    expect(decision).toMatchObject({ action: "repair", plan: { round: 1 } });
  });
});
