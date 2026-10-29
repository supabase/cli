import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";

import { afterEach, describe, expect, test } from "bun:test";

import { generatePrDiff } from "./generate-pr-diff.ts";

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: git ${args.join(" ")}`);
  }
  return result.stdout.toString().trim();
}

const setupRepository = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "ai-review-diff-" });
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");

  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "develop", seed);
  git(seed, "config", "user.name", "AI Review Test");
  git(seed, "config", "user.email", "ai-review@example.test");
  yield* fs.writeFileString(join(seed, "shared.txt"), "common\n");
  git(seed, "add", "shared.txt");
  git(seed, "commit", "-m", "common base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "develop");
  git(root, "clone", "--branch", "develop", remote, checkout);
  return { seed, checkout };
});

function publishPullRequest(seed: string, prNumber: number): void {
  git(seed, "push", "--force", "origin", `HEAD:refs/pull/${prNumber}/head`);
}

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const directory of temporaryDirectories.splice(0)) {
        yield* fs.remove(directory, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunFileSystem.layer)),
  ),
);

describe("generatePrDiff", () => {
  test("writes a complete diff beyond GitHub's 20,000-line API limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const { seed, checkout } = yield* setupRepository();
        git(seed, "switch", "-c", "large-pr");
        const lines = Array.from({ length: 20_001 }, (_, index) => `added line ${index + 1}`);
        yield* fs.writeFileString(join(seed, "large.txt"), `${lines.join("\n")}\n`);
        git(seed, "add", "large.txt");
        git(seed, "commit", "-m", "large change");
        publishPullRequest(seed, 42);

        const outputPath = join(checkout, "pr.diff");
        generatePrDiff({ repositoryPath: checkout, prNumber: 42, baseRef: "develop", outputPath });

        const diff = yield* fs.readFileString(outputPath);
        expect(diff).toContain("+added line 1\n");
        expect(diff).toContain("+added line 20001\n");
        expect(diff.match(/^\+added line /gm)).toHaveLength(20_001);
      }).pipe(Effect.provide(layer)),
    ));

  test("uses the merge base when the base and PR branches diverge", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const { seed, checkout } = yield* setupRepository();
        git(seed, "switch", "-c", "feature");
        yield* fs.writeFileString(join(seed, "shared.txt"), "feature\n");
        git(seed, "add", "shared.txt");
        git(seed, "commit", "-m", "feature change");
        publishPullRequest(seed, 77);

        git(seed, "switch", "develop");
        yield* fs.writeFileString(join(seed, "base-only.txt"), "base progressed\n");
        git(seed, "add", "base-only.txt");
        git(seed, "commit", "-m", "base change");
        git(seed, "push", "origin", "develop");

        const outputPath = join(checkout, "pr.diff");
        generatePrDiff({ repositoryPath: checkout, prNumber: 77, baseRef: "develop", outputPath });

        const diff = yield* fs.readFileString(outputPath);
        expect(diff).toContain("diff --git a/shared.txt b/shared.txt");
        expect(diff).toContain("+feature");
        expect(diff).not.toContain("base-only.txt");
      }).pipe(Effect.provide(layer)),
    ));

  test("diffs the pinned head even after the PR branch moves", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const { seed, checkout } = yield* setupRepository();
        git(seed, "switch", "-c", "feature");
        yield* fs.writeFileString(join(seed, "reviewed.txt"), "reviewed\n");
        git(seed, "add", "reviewed.txt");
        git(seed, "commit", "-m", "reviewed change");
        publishPullRequest(seed, 88);
        const headSha = git(seed, "rev-parse", "HEAD");
        yield* fs.writeFileString(join(seed, "late.txt"), "pushed during the review\n");
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

        const diff = yield* fs.readFileString(outputPath);
        expect(diff).toContain("+reviewed");
        expect(diff).not.toContain("late.txt");
      }).pipe(Effect.provide(layer)),
    ));

  test("writes only the sync branch's own resolution and repairs for a develop-into-next sync", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const { seed, checkout } = yield* setupRepository();
        const commit = Effect.fnUntraced(function* (
          file: string,
          content: string,
          message: string,
        ) {
          yield* fs.writeFileString(join(seed, file), content);
          git(seed, "add", file);
          git(seed, "commit", "-m", message);
        });
        git(seed, "switch", "-c", "next");
        yield* commit("shared.txt", "next side\n", "next change");
        git(seed, "push", "origin", "next");
        git(seed, "switch", "develop");
        yield* commit("shared.txt", "develop side\n", "develop change");
        yield* commit("develop-only.txt", "reviewed on develop\n", "develop feature");
        git(seed, "push", "origin", "develop");

        git(seed, "switch", "-c", "sync");
        expect(() => git(seed, "merge", "next")).toThrow();
        yield* commit("shared.txt", "resolved by claude\n", "resolve the sync");
        yield* commit("repair.txt", "repair\n", "repair the sync");
        publishPullRequest(seed, 99);

        const syncResolutionPath = join(checkout, "sync-resolution.diff");
        generatePrDiff({
          repositoryPath: checkout,
          prNumber: 99,
          baseRef: "next",
          outputPath: join(checkout, "pr.diff"),
          syncResolutionPath,
        });

        const diff = yield* fs.readFileString(syncResolutionPath);
        expect(diff).toContain("+resolved by claude");
        expect(diff).toContain("+repair");
        expect(diff).not.toContain("develop-only.txt");
        expect(diff).not.toContain("+develop side");
      }).pipe(Effect.provide(layer)),
    ));
});
