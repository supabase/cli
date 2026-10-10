import { afterEach, describe, expect, test } from "bun:test";

import { makeGit } from "./promotion-shared.ts";
import { createTestRepo, git, type TestRepo } from "./promotion-test-repo.ts";
import { type RepairPlan, findingOrigins } from "./sync-repair.ts";

const repos: TestRepo[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    repo.cleanup();
  }
});

describe("findingOrigins", () => {
  test("names the branches that already have the commented line", () => {
    const repo = createTestRepo();
    repos.push(repo);
    for (const branch of ["develop", "next"]) {
      git(repo.seed, "switch", "-q", "-c", branch, "main");
      repo.commit(
        repo.seed,
        "a.ts",
        `const shared = 1;\nconst ${branch} = 2;\n`,
        `feat: ${branch}`,
      );
      git(repo.seed, "push", "-q", "origin", branch);
    }
    const head = repo.commit(
      repo.seed,
      "a.ts",
      "const shared = 1;\nconst develop = 2;\nconst merged = develop + next;\n",
      "Merge develop",
    );
    git(repo.seed, "push", "-q", "origin", "HEAD:refs/heads/sync/develop-into-next");
    const checkout = repo.checkout();
    const plan: RepairPlan = {
      source: "develop",
      target: "next",
      pullRequest: 1,
      head,
      round: 1,
      failures: [],
      findings: [],
      reviewBody: null,
    };
    const origins = (line: number) =>
      findingOrigins(makeGit(checkout), plan, {
        threadId: "T",
        commentId: 1,
        path: "a.ts",
        line,
        body: "",
      });

    expect(origins(1)).toEqual(["develop", "next"]);
    expect(origins(2)).toEqual(["develop"]);
    expect(origins(3)).toEqual([]);
  });
});
