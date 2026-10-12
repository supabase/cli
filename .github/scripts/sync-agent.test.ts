import { describe, expect, test } from "bun:test";

import { type CheckRun, REQUIRED_CHECKS } from "./fast-forward.ts";
import { planRepair, type ReviewThread } from "./sync-agent.ts";

const HEAD = "a".repeat(40);
const RESOLVED = "<!-- sync-agent resolve -->\nClaude resolved the merge.";
const repaired = (head: string) => `<!-- sync-agent repair head=${head} -->`;

function run(id: number, name: string, conclusion: string | null = "success"): CheckRun {
  return { id, name, status: conclusion === null ? "in_progress" : "completed", conclusion };
}

const green = REQUIRED_CHECKS.map((name, index) => run(index + 1, name));
const finding: ReviewThread = {
  threadId: "T_1",
  commentId: 7,
  path: "apps/cli/src/index.ts",
  line: 3,
  body: "This drops develop's fix.",
};

describe("planRepair", () => {
  test("repairs a failed job once the head's checks settle, ignoring the branch-policy check", () => {
    const failed = run(99, "Check code quality", "failure");
    const plan = planRepair({
      head: HEAD,
      botComments: [RESOLVED],
      runs: [...green, failed, run(100, "Require fast-forward", "failure")],
      threads: [],
    });

    expect(plan).toEqual({ action: "repair", failures: [failed], threads: [] });
  });

  test("waits while a check runs or a required check has not started", () => {
    const running = planRepair({
      head: HEAD,
      botComments: [RESOLVED],
      runs: [...green, run(99, "CodeQL", null)],
      threads: [finding],
    });
    const missing = planRepair({
      head: HEAD,
      botComments: [RESOLVED],
      runs: green.slice(1),
      threads: [finding],
    });

    expect(running).toEqual({ action: "skip", reason: "Checks are still running." });
    expect(missing).toEqual({ action: "skip", reason: "Checks are still running." });
  });

  test("leaves a hand-resolved pull request to the maintainer", () => {
    const plan = planRepair({ head: HEAD, botComments: [], runs: green, threads: [finding] });

    expect(plan.action).toBe("skip");
  });

  test("uses the latest attempt of a re-run job", () => {
    const plan = planRepair({
      head: HEAD,
      botComments: [RESOLVED],
      runs: [...green, run(-1, "Check code quality", "failure")],
      threads: [],
    });

    expect(plan).toEqual({ action: "skip", reason: "Nothing to repair." });
  });

  test("does not repair the same head twice unless new findings arrive", () => {
    const state = {
      head: HEAD,
      botComments: [RESOLVED, repaired(HEAD)],
      runs: [...green, run(99, "Check code quality", "failure")],
    };

    expect(planRepair({ ...state, threads: [] }).action).toBe("skip");
    expect(planRepair({ ...state, threads: [finding] }).action).toBe("repair");
  });

  test("hands the pull request to a maintainer once after the round limit", () => {
    const state = {
      head: HEAD,
      runs: [...green, run(99, "Check code quality", "failure")],
      threads: [],
    };
    const rounds = [RESOLVED, repaired("b".repeat(40)), repaired("c".repeat(40))];

    expect(planRepair({ ...state, botComments: rounds }).action).toBe("exhausted");
    expect(
      planRepair({ ...state, botComments: [...rounds, "<!-- sync-agent exhausted -->"] }).action,
    ).toBe("skip");
  });
});
