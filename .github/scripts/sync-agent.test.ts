import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CheckRun, REQUIRED_CHECKS } from "./fast-forward.ts";
import { createTestRepo, git, type TestRepo } from "./promotion-test-repo.ts";
import {
  buildSuggestions,
  leftoverConflictMarkers,
  planRepair,
  type ReviewThread,
  verifyWorkflows,
} from "./sync-agent.ts";

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

  test("repairs a required check that ended without succeeding, such as a cancelled one", () => {
    const cancelled = run(99, REQUIRED_CHECKS[0] ?? "", "cancelled");
    const plan = planRepair({
      head: HEAD,
      reviewRunning: false,
      botComments: [RESOLVED],
      runs: [...green, cancelled],
      threads: [],
    });

    expect(plan).toEqual({ action: "repair", failures: [cancelled], threads: [] });
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

  test("fences replacement text that contains backticks and leaves mode changes to apply by hand", () => {
    const { comments, leftover } = buildSuggestions(
      [
        "diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml",
        "--- a/.github/workflows/test.yml",
        "+++ b/.github/workflows/test.yml",
        "@@ -3 +3 @@",
        "-          run: echo",
        "+          run: echo ```",
        "diff --git a/.github/run.sh b/.github/run.sh",
        "old mode 100644",
        "new mode 100755",
        "--- a/.github/run.sh",
        "+++ b/.github/run.sh",
        "@@ -1 +1 @@",
        "-echo a",
        "+echo b",
        "",
      ].join("\n"),
      new Map([
        [".github/workflows/test.yml", [[1, 10]]],
        [".github/run.sh", [[1, 10]]],
      ]),
      () => "",
    );

    expect(comments.map((comment) => comment.body)).toEqual([
      "````suggestion\n          run: echo ```\n````",
    ]);
    expect(leftover).toContain("new mode 100755");
  });

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

describe("verifyWorkflows", () => {
  const repos: TestRepo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) {
      repo.cleanup();
    }
  });

  /** A sync branch at `develop` and a `next` that edits a workflow, checked out the way the publish job sees them. */
  function syncCheckout() {
    const repo = createTestRepo();
    repos.push(repo);
    mkdirSync(join(repo.seed, ".github"));
    repo.commit(repo.seed, ".github/ci.yml", "on: push\n", "ci: add workflow");
    git(repo.seed, "push", "origin", "main:develop", "main:sync/develop-into-next");
    git(repo.seed, "switch", "-c", "next");
    repo.commit(repo.seed, ".github/ci.yml", "on: pull_request\n", "ci: next trigger");
    git(repo.seed, "push", "origin", "next");
    const checkout = repo.checkout();
    git(checkout, "switch", "sync/develop-into-next");
    git(checkout, "merge", "--no-ff", "--no-edit", "origin/next");
    return { repo, checkout };
  }

  test("accepts git's merge of next", () => {
    const { checkout } = syncCheckout();

    expect(() => verifyWorkflows(checkout, "origin/sync/develop-into-next", "HEAD")).not.toThrow();
  });

  test("rejects a workflow added through a merge of a commit outside next", () => {
    const { repo, checkout } = syncCheckout();
    git(checkout, "switch", "-c", "forged", "HEAD~1");
    repo.commit(checkout, ".github/evil.yml", "on: push\n", "ci: evil");
    git(checkout, "switch", "sync/develop-into-next");
    git(checkout, "merge", "--no-ff", "--no-edit", "forged");

    expect(() => verifyWorkflows(checkout, "origin/sync/develop-into-next", "HEAD")).toThrow(
      "merges a commit outside origin/next",
    );
  });

  test("rejects a workflow added in a plain commit", () => {
    const { repo, checkout } = syncCheckout();
    repo.commit(checkout, ".github/evil.yml", "on: push\n", "ci: evil");

    expect(() => verifyWorkflows(checkout, "origin/sync/develop-into-next", "HEAD")).toThrow(
      "workflow edits must come from a maintainer",
    );
  });
});

describe("leftoverConflictMarkers", () => {
  test("finds every zdiff3 marker line and ignores marker-like text", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-agent-"));
    writeFileSync(
      join(dir, "a.ts"),
      ["ok", "<<<<<<< HEAD", "|||||||", "=======", ">>>>>>> next", "======= not a marker"].join(
        "\n",
      ),
    );

    try {
      expect(leftoverConflictMarkers(dir, ["a.ts", "missing.ts"])).toEqual([
        "a.ts:2",
        "a.ts:3",
        "a.ts:4",
        "a.ts:5",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
