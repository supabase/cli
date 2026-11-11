import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { generatePrDiff } from "./generate-pr-diff.ts";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function setupRepository(): { seed: string; checkout: string } {
  const root = mkdtempSync(join(tmpdir(), "ai-review-diff-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");

  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "develop", seed);
  git(seed, "config", "user.name", "AI Review Test");
  git(seed, "config", "user.email", "ai-review@example.test");
  writeFileSync(join(seed, "shared.txt"), "common\n");
  git(seed, "add", "shared.txt");
  git(seed, "commit", "-m", "common base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "develop");
  git(root, "clone", "--branch", "develop", remote, checkout);
  return { seed, checkout };
}

function publishPullRequest(seed: string, prNumber: number): void {
  git(seed, "push", "--force", "origin", `HEAD:refs/pull/${prNumber}/head`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("generatePrDiff", () => {
  test("writes a complete diff beyond GitHub's 20,000-line API limit", () => {
    const { seed, checkout } = setupRepository();
    git(seed, "switch", "-c", "large-pr");
    const lines = Array.from({ length: 20_001 }, (_, index) => `added line ${index + 1}`);
    writeFileSync(join(seed, "large.txt"), `${lines.join("\n")}\n`);
    git(seed, "add", "large.txt");
    git(seed, "commit", "-m", "large change");
    publishPullRequest(seed, 42);

    const outputPath = join(checkout, "pr.diff");
    generatePrDiff({ repositoryPath: checkout, prNumber: 42, baseRef: "develop", outputPath });

    const diff = readFileSync(outputPath, "utf8");
    expect(diff).toContain("+added line 1\n");
    expect(diff).toContain("+added line 20001\n");
    expect(diff.match(/^\+added line /gm)).toHaveLength(20_001);
  });

  test("uses the merge base when the base and PR branches diverge", () => {
    const { seed, checkout } = setupRepository();
    git(seed, "switch", "-c", "feature");
    writeFileSync(join(seed, "shared.txt"), "feature\n");
    git(seed, "add", "shared.txt");
    git(seed, "commit", "-m", "feature change");
    publishPullRequest(seed, 77);

    git(seed, "switch", "develop");
    writeFileSync(join(seed, "base-only.txt"), "base progressed\n");
    git(seed, "add", "base-only.txt");
    git(seed, "commit", "-m", "base change");
    git(seed, "push", "origin", "develop");

    const outputPath = join(checkout, "pr.diff");
    generatePrDiff({ repositoryPath: checkout, prNumber: 77, baseRef: "develop", outputPath });

    const diff = readFileSync(outputPath, "utf8");
    expect(diff).toContain("diff --git a/shared.txt b/shared.txt");
    expect(diff).toContain("+feature");
    expect(diff).not.toContain("base-only.txt");
  });

  test("diffs the pinned head even after the PR branch moves", () => {
    const { seed, checkout } = setupRepository();
    git(seed, "switch", "-c", "feature");
    writeFileSync(join(seed, "reviewed.txt"), "reviewed\n");
    git(seed, "add", "reviewed.txt");
    git(seed, "commit", "-m", "reviewed change");
    publishPullRequest(seed, 88);
    const headSha = git(seed, "rev-parse", "HEAD");
    writeFileSync(join(seed, "late.txt"), "pushed during the review\n");
    git(seed, "add", "late.txt");
    git(seed, "commit", "-m", "late change");
    publishPullRequest(seed, 88);

    const outputPath = join(checkout, "pr.diff");
    generatePrDiff({
      repositoryPath: checkout,
      prNumber: 88,
      baseRef: "develop",
      outputPath,
      headSha,
    });

    const diff = readFileSync(outputPath, "utf8");
    expect(diff).toContain("+reviewed");
    expect(diff).not.toContain("late.txt");
  });

  test("writes only the sync branch's own resolution and repairs for a develop-into-next sync", () => {
    const { seed, checkout } = setupRepository();
    const commit = (file: string, content: string, message: string) => {
      writeFileSync(join(seed, file), content);
      git(seed, "add", file);
      git(seed, "commit", "-m", message);
    };
    git(seed, "switch", "-c", "next");
    commit("shared.txt", "next side\n", "next change");
    git(seed, "push", "origin", "next");
    git(seed, "switch", "develop");
    commit("shared.txt", "develop side\n", "develop change");
    commit("develop-only.txt", "reviewed on develop\n", "develop feature");
    git(seed, "push", "origin", "develop");

    git(seed, "switch", "-c", "sync");
    expect(() => git(seed, "merge", "next")).toThrow();
    commit("shared.txt", "resolved by claude\n", "resolve the sync");
    commit("repair.txt", "repair\n", "repair the sync");
    publishPullRequest(seed, 99);

    const syncResolutionPath = join(checkout, "sync-resolution.diff");
    generatePrDiff({
      repositoryPath: checkout,
      prNumber: 99,
      baseRef: "next",
      outputPath: join(checkout, "pr.diff"),
      syncResolutionPath,
    });

    const diff = readFileSync(syncResolutionPath, "utf8");
    expect(diff).toContain("+resolved by claude");
    expect(diff).toContain("+repair");
    expect(diff).not.toContain("develop-only.txt");
    expect(diff).not.toContain("+develop side");
  });
});
