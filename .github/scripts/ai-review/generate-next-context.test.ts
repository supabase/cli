import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { generateNextContext } from "./generate-next-context.ts";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function commitFile(seed: string, file: string, message: string): void {
  writeFileSync(join(seed, file), `${message}\n`);
  git(seed, "add", file);
  git(seed, "commit", "-m", message);
}

function setupRepository(options: { withNext: boolean }): { checkout: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), "ai-review-next-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");

  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "develop", seed);
  git(seed, "config", "user.name", "AI Review Test");
  git(seed, "config", "user.email", "ai-review@example.test");
  commitFile(seed, "shared.txt", "chore: common base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "develop");
  if (options.withNext) {
    git(seed, "switch", "-c", "next");
    commitFile(seed, "go.txt", "chore: tidy");
    commitFile(seed, "sidecar.txt", "feat(cli)!: remove the Go sidecar");
    git(seed, "push", "origin", "next");
  }
  git(root, "clone", "--branch", "develop", remote, checkout);
  git(checkout, "update-ref", "refs/ai-review/base", "refs/remotes/origin/develop");
  return { checkout, output: join(root, "out", "next-context.md") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("generateNextContext", () => {
  test("writes breaking titles first and the changed files when next exists", () => {
    const { checkout, output } = setupRepository({ withNext: true });

    expect(
      generateNextContext({ repositoryPath: checkout, baseRef: "develop", outputPath: output }),
    ).toBe(true);

    const context = readFileSync(output, "utf8");
    expect(context.indexOf("- feat(cli)!: remove the Go sidecar")).toBeGreaterThan(-1);
    expect(context.indexOf("- feat(cli)!: remove the Go sidecar")).toBeLessThan(
      context.indexOf("- chore: tidy"),
    );
    expect(context).toContain("sidecar.txt");
    expect(context).not.toContain("common base");
  });

  test("writes nothing when next does not exist", () => {
    const { checkout, output } = setupRepository({ withNext: false });

    expect(
      generateNextContext({ repositoryPath: checkout, baseRef: "develop", outputPath: output }),
    ).toBe(false);
    expect(existsSync(output)).toBe(false);
  });

  test("writes nothing for pull requests that do not target develop", () => {
    const { checkout, output } = setupRepository({ withNext: true });

    expect(
      generateNextContext({ repositoryPath: checkout, baseRef: "main", outputPath: output }),
    ).toBe(false);
    expect(existsSync(output)).toBe(false);
  });
});
