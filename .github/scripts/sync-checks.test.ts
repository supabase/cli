import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeGit } from "./promotion-shared.ts";
import { createTestRepo, git, type TestRepo } from "./promotion-test-repo.ts";
import type { AgentResolution } from "./sync-agent.ts";
import { checkAndFix } from "./sync-checks.ts";

const repos: TestRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.cleanup();
  }
});

function mergedCheckout(): { checkout: string; merge: string } {
  const repo = createTestRepo();
  repos.push(repo);
  const checkout = repo.checkout();
  writeFileSync(join(checkout, "shared.txt"), "next\ndevelop\n");
  git(checkout, "commit", "-qam", "Merge develop");
  return { checkout, merge: git(checkout, "rev-parse", "HEAD") };
}

/** Fails while shared.txt still mentions develop, the way a type check fails on a stale name. */
const staleNameCheck = (checkout: string) => () => {
  const passed = !readFileSync(join(checkout, "shared.txt"), "utf8").includes("develop");
  return {
    passed,
    output: passed ? "" : "shared.txt(2,1): error TS2304: Cannot find name 'develop'.",
  };
};

function fixed(overrides: Partial<AgentResolution> = {}): AgentResolution {
  return {
    status: "resolved",
    summary: "Dropped the stale name.",
    files: [{ path: "shared.txt", resolution: "Dropped the stale name.", precedent: null }],
    deletedFiles: [],
    decisions: [],
    ...overrides,
  };
}

describe("checkAndFix", () => {
  test("commits the formatter's changes on top of the merge and drops generated files", async () => {
    const { checkout, merge } = mergedCheckout();

    const check = await checkAndFix(
      makeGit(checkout),
      () => {
        writeFileSync(join(checkout, "shared.txt"), "next\n  develop\n");
        writeFileSync(join(checkout, "generated.txt"), "build output\n");
        return { passed: true, output: "" };
      },
      async () => "unused",
      "chore(repo): fix checks",
    );

    expect(check).toEqual({
      passed: true,
      fixes: [
        {
          path: "shared.txt",
          resolution: "Formatted with the repository formatter.",
          precedent: null,
        },
      ],
      decisions: [],
    });
    expect(git(checkout, "rev-parse", "HEAD^")).toBe(merge);
    expect(git(checkout, "show", "HEAD:shared.txt")).toBe("next\n  develop");
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  test("commits edits staged before the checks without calling them formatting", async () => {
    const { checkout, merge } = mergedCheckout();
    writeFileSync(join(checkout, "shared.txt"), "repaired\n");
    git(checkout, "add", "shared.txt");

    const check = await checkAndFix(
      makeGit(checkout),
      () => ({ passed: true, output: "" }),
      async () => "unused",
      "chore(repo): address checks",
    );

    expect(check).toEqual({ passed: true, fixes: [], decisions: [] });
    expect(git(checkout, "rev-parse", "HEAD^")).toBe(merge);
    expect(git(checkout, "show", "HEAD:shared.txt")).toBe("repaired");
  });

  test("commits a fix that makes the checks pass, with its decisions", async () => {
    const { checkout, merge } = mergedCheckout();
    const decision = {
      paths: ["shared.txt"],
      question: "Which name?",
      chosen: "next's",
      alternative: "develop's",
    };

    const check = await checkAndFix(
      makeGit(checkout),
      staleNameCheck(checkout),
      async (output) => {
        expect(output).toContain("error TS2304");
        writeFileSync(join(checkout, "shared.txt"), "next\n");
        return fixed({ decisions: [decision] });
      },
      "chore(repo): fix checks",
    );

    expect(check).toEqual({
      passed: true,
      fixes: [{ path: "shared.txt", resolution: "Dropped the stale name.", precedent: null }],
      decisions: [decision],
    });
    expect(git(checkout, "rev-parse", "HEAD^")).toBe(merge);
    expect(git(checkout, "show", "HEAD:shared.txt")).toBe("next");
  });

  test("drops an unresolved fix and reports the failing output", async () => {
    const { checkout, merge } = mergedCheckout();

    const check = await checkAndFix(
      makeGit(checkout),
      staleNameCheck(checkout),
      async () => {
        writeFileSync(join(checkout, "shared.txt"), "half edited\n");
        return fixed({ status: "unresolved" });
      },
      "chore(repo): fix checks",
    );

    expect(check).toMatchObject({ passed: false, fixes: [], decisions: [] });
    expect(check.remaining).toContain("error TS2304");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(merge);
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });
});
