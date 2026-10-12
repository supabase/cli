import { describe, expect, test } from "bun:test";

import { type CheckRun, REQUIRED_CHECKS } from "./fast-forward.ts";
import { buildSuggestions, planRepair, type ReviewThread } from "./sync-agent.ts";

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
      reviewRunning: false,
      botComments: [RESOLVED],
      runs: [...green, failed, run(100, "Require fast-forward", "failure")],
      threads: [],
    });

    expect(plan).toEqual({ action: "repair", failures: [failed], threads: [] });
  });

  test("waits while a check runs or a required check has not started", () => {
    const running = planRepair({
      head: HEAD,
      reviewRunning: false,
      botComments: [RESOLVED],
      runs: [...green, run(99, "CodeQL", null)],
      threads: [finding],
    });
    const missing = planRepair({
      head: HEAD,
      reviewRunning: false,
      botComments: [RESOLVED],
      runs: green.slice(1),
      threads: [finding],
    });

    expect(running).toEqual({ action: "skip", reason: "Checks are still running." });
    expect(missing).toEqual({ action: "skip", reason: "Checks are still running." });
  });

  test("leaves a hand-resolved pull request to the maintainer", () => {
    const plan = planRepair({
      head: HEAD,
      botComments: [],
      runs: green,
      threads: [finding],
      reviewRunning: false,
    });

    expect(plan.action).toBe("skip");
  });

  test("uses the latest attempt of a re-run job", () => {
    const plan = planRepair({
      head: HEAD,
      reviewRunning: false,
      botComments: [RESOLVED],
      runs: [...green, run(-1, "Check code quality", "failure")],
      threads: [],
    });

    expect(plan).toEqual({ action: "skip", reason: "Nothing to repair." });
  });

  test("hands a head a round left failing to a maintainer unless new findings arrive", () => {
    const state = {
      head: HEAD,
      reviewRunning: false,
      botComments: [RESOLVED, repaired(HEAD)],
      runs: [...green, run(99, "Check code quality", "failure")],
    };

    expect(planRepair({ ...state, threads: [] }).action).toBe("exhausted");
    expect(planRepair({ ...state, threads: [finding] }).action).toBe("repair");
  });

  test("hands the pull request to a maintainer once after the round limit", () => {
    const state = {
      head: HEAD,
      reviewRunning: false,
      runs: [...green, run(99, "Check code quality", "failure")],
      threads: [],
    };
    const rounds = [RESOLVED, repaired("b".repeat(40)), repaired("c".repeat(40))];

    expect(planRepair({ ...state, botComments: rounds }).action).toBe("exhausted");
  });

  test("stops repairing after the handoff, even on a maintainer's new head", () => {
    const plan = planRepair({
      head: "d".repeat(40),
      reviewRunning: false,
      botComments: [RESOLVED, repaired(HEAD), "<!-- sync-agent exhausted -->"],
      runs: [...green, run(99, "Check code quality", "failure")],
      threads: [finding],
    });

    expect(plan).toEqual({ action: "skip", reason: "Already handed to a maintainer." });
  });

  test("waits for this pull request's AI review to finish", () => {
    const plan = planRepair({
      head: HEAD,
      reviewRunning: true,
      botComments: [RESOLVED],
      runs: [...green, run(99, "Check code quality", "failure")],
      threads: [],
    });

    expect(plan).toEqual({ action: "skip", reason: "The AI review is still running." });
  });

  test("waits while workflow suggestions on the head are not committed", () => {
    const plan = planRepair({
      head: HEAD,
      reviewRunning: false,
      botComments: [RESOLVED, `<!-- sync-agent workflow-suggestions head=${HEAD} -->`],
      runs: [...green, run(99, "Check code quality", "failure")],
      threads: [],
    });

    expect(plan.action).toBe("skip");
  });
});

describe("buildSuggestions", () => {
  const diff = [
    "diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml",
    "--- a/.github/workflows/test.yml",
    "+++ b/.github/workflows/test.yml",
    "@@ -10 +9,0 @@",
    '-          go-cache: "false"',
    "@@ -20,0 +20 @@",
    "+          shell: bash",
    "@@ -90 +89 @@",
    "-          old: true",
    "+          new: true",
    "diff --git a/.github/workflows/go.yml b/.github/workflows/go.yml",
    "deleted file mode 100644",
    "--- a/.github/workflows/go.yml",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-name: Go",
    "",
  ].join("\n");

  test("suggests edits inside the pull request's diff and leaves the rest to apply by hand", () => {
    const { comments, leftover } = buildSuggestions(
      diff,
      new Map([[".github/workflows/test.yml", [[5, 25]]]]),
      (_path, line) => `line ${line}`,
    );

    expect(comments).toEqual([
      { path: ".github/workflows/test.yml", line: 10, side: "RIGHT", body: "```suggestion\n```" },
      {
        path: ".github/workflows/test.yml",
        line: 20,
        side: "RIGHT",
        body: "```suggestion\nline 20\n          shell: bash\n```",
      },
    ]);
    expect(leftover).toContain("@@ -90 +89 @@");
    expect(leftover).toContain("deleted file mode 100644");
    expect(leftover).not.toContain("go-cache");
  });
});
