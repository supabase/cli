import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, type Scope } from "effect";
import process from "node:process";
import type { AnalyzeCommitsContext, Commit, GenerateNotesContext } from "semantic-release";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  PACKAGE_PATH_PREFIX,
  analyzeCommits,
  filterCommitsToPackage,
  generateNotes,
} from "./semantic-release-path-filter.ts";

// Hermetic git identity/signing: the developer's global gitconfig may require
// commit signing, which would hang or fail these commits otherwise.
const GIT_HERMETIC_CONFIG = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "-c",
  "commit.gpgsign=false",
];

function runTest<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));
}

function git(cwd: string, args: string[]) {
  return Effect.gen(function* () {
    const proc = Bun.spawn(["git", ...GIT_HERMETIC_CONFIG, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
      Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
    );
    if (exitCode !== 0) {
      return yield* Effect.die(
        new Error(`git ${args.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`),
      );
    }
    return stdout;
  });
}

function commitFiles(cwd: string, files: Record<string, string>, message: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { dirname, join } = yield* Path.Path;
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = join(cwd, relativePath);
      yield* fs.makeDirectory(dirname(fullPath), { recursive: true });
      yield* fs.writeFileString(fullPath, content);
    }
    yield* git(cwd, ["add", ...Object.keys(files)]);
    yield* git(cwd, ["commit", "-m", message]);
    return (yield* git(cwd, ["rev-parse", "HEAD"])).trim();
  });
}

function fakeCommit(hash: string, message: string): Commit {
  return {
    commit: { long: hash, short: hash.slice(0, 7) },
    tree: { long: hash, short: hash.slice(0, 7) },
    author: { name: "t", email: "t@t", short: "2024-01-01" },
    committer: { name: "t", email: "t@t", short: "2024-01-01" },
    subject: message.split("\n")[0] ?? message,
    body: "",
    message,
    hash,
    committerDate: "2024-01-01",
  };
}

// AnalyzeCommitsContext pulls in every field of semantic-release's
// VerifyConditionsContext/BaseContext, but `analyzeCommits()` only reads
// `commits`/`cwd`/`logger.log`; the rest is dummy filler to satisfy the type.
function fakeAnalyzeCommitsContext(commits: Commit[], cwd: string): AnalyzeCommitsContext {
  return {
    commits,
    cwd,
    releases: [],
    lastRelease: {
      version: "0.0.0",
      gitTag: "v0.0.0",
      channels: [],
      gitHead: "0".repeat(40),
      name: "v0.0.0",
    },
    stdout: process.stdout,
    stderr: process.stderr,
    env: {},
    envCi: { isCi: false, commit: "", branch: "main" },
    branch: { name: "main" },
    branches: [{ name: "main" }],
    options: {},
    logger: { log: () => {} },
  };
}

describe("semantic-release-path-filter", () => {
  let repoDir: string;
  let hashConfigOnly: string;
  let hashCliOnly: string;
  let hashBoth: string;
  let hashPrefixTrap: string;
  let hashNonAsciiPath: string;
  let hashMerge: string;

  beforeAll(() =>
    runTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        repoDir = yield* fs.makeTempDirectory({ prefix: "semantic-release-path-filter-" });
        yield* git(repoDir, ["init", "-b", "main", "-q"]);

        // Seed a plain root commit so the main scenario commits all exercise the
        // ordinary (parented) diff path; the root-commit case (`--root`) has its
        // own dedicated test below.
        yield* commitFiles(repoDir, { "README.md": "seed\n" }, "chore: seed repo root commit");

        hashConfigOnly = yield* commitFiles(
          repoDir,
          { "packages/config/src/foo.ts": "export const foo = 1;\n" },
          "chore: seed packages/config/src/foo.ts",
        );
        hashCliOnly = yield* commitFiles(
          repoDir,
          { "apps/cli/src/bar.ts": "export const bar = 1;\n" },
          "chore: seed apps/cli/src/bar.ts",
        );
        hashBoth = yield* commitFiles(
          repoDir,
          {
            "packages/config/src/foo2.ts": "export const foo2 = 1;\n",
            "apps/cli/src/bar2.ts": "export const bar2 = 1;\n",
          },
          "chore: seed both packages/config and apps/cli files",
        );
        hashPrefixTrap = yield* commitFiles(
          repoDir,
          { "packages/config-other/x.ts": "export const x = 1;\n" },
          "chore: seed packages/config-other, a prefix-adjacent trap",
        );
        hashNonAsciiPath = yield* commitFiles(
          repoDir,
          { "packages/config/src/café.ts": "export const café = 1;\n" },
          "chore: seed a non-ASCII path under packages/config",
        );

        yield* git(repoDir, ["checkout", "-b", "feature", "-q"]);
        yield* commitFiles(
          repoDir,
          { "packages/config/src/on-branch.ts": "export const onBranch = 1;\n" },
          "chore: seed a commit on the feature branch",
        );
        yield* git(repoDir, ["checkout", "main", "-q"]);
        yield* git(repoDir, ["merge", "--no-ff", "feature", "-m", "merge: merge feature branch"]);
        hashMerge = (yield* git(repoDir, ["rev-parse", "HEAD"])).trim();
      }),
    ),
  );

  afterAll(() =>
    runTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(repoDir, { recursive: true, force: true });
      }),
    ),
  );

  test("PACKAGE_PATH_PREFIX is the packages/config/ prefix the release train filters commits against", () => {
    expect(PACKAGE_PATH_PREFIX).toBe("packages/config/");
  });

  describe("filterCommitsToPackage", () => {
    test("keeps only commits whose diff touches packages/config/**, preserving the input's order", () =>
      runTest(
        Effect.gen(function* () {
          const shuffledInput = [
            hashCliOnly,
            hashBoth,
            hashPrefixTrap,
            hashMerge,
            hashConfigOnly,
          ].map((hash) => ({
            hash,
          }));

          const result = yield* Effect.promise(() =>
            filterCommitsToPackage(shuffledInput, repoDir),
          );

          expect(result).toEqual([{ hash: hashBoth }, { hash: hashConfigOnly }]);
        }),
      ));

    test("excludes a merge commit even though the branch it merged touched packages/config/**", () =>
      runTest(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            filterCommitsToPackage([{ hash: hashMerge }], repoDir),
          );

          expect(result).toEqual([]);
        }),
      ));

    test("does not treat packages/config-other/ as a match for the packages/config/ prefix", () =>
      runTest(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            filterCommitsToPackage([{ hash: hashPrefixTrap }], repoDir),
          );

          expect(result).toEqual([]);
        }),
      ));

    test("returns an empty array for empty input", () =>
      runTest(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => filterCommitsToPackage([], repoDir));

          expect(result).toEqual([]);
        }),
      ));

    test("includes a commit whose only config path is non-ASCII (core.quotePath would C-quote it without -z)", () =>
      runTest(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            filterCommitsToPackage([{ hash: hashNonAsciiPath }], repoDir),
          );

          expect(result).toEqual([{ hash: hashNonAsciiPath }]);
        }),
      ));

    test("includes a root commit that touches packages/config/** (--root diffs it against the empty tree)", () =>
      runTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootRepoDir = yield* fs.makeTempDirectoryScoped({
            prefix: "semantic-release-path-filter-root-",
          });

          yield* git(rootRepoDir, ["init", "-b", "main", "-q"]);
          const rootHash = yield* commitFiles(
            rootRepoDir,
            { "packages/config/src/first.ts": "export const first = 1;\n" },
            "chore: repo root commit touching packages/config",
          );

          const result = yield* Effect.promise(() =>
            filterCommitsToPackage([{ hash: rootHash }], rootRepoDir),
          );

          expect(result).toEqual([{ hash: rootHash }]);
        }),
      ));

    test("rejects an abbreviated hash instead of silently dropping its commit (diff-tree echoes full OIDs)", () =>
      expect(
        filterCommitsToPackage([{ hash: hashConfigOnly.slice(0, 7) }], repoDir),
      ).rejects.toThrow(/full lowercase hex object IDs/));

    test("rejects with a descriptive error when git diff-tree exits non-zero", () =>
      runTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const notARepo = yield* fs.makeTempDirectoryScoped({
            prefix: "semantic-release-path-filter-not-a-repo-",
          });

          yield* Effect.promise(() =>
            expect(filterCommitsToPackage([{ hash: "a".repeat(40) }], notARepo)).rejects.toThrow(
              /^git diff-tree --stdin failed with exit code 128: /,
            ),
          );
        }),
      ));
  });

  describe("analyzeCommits", () => {
    test('resolves "minor" for a feat(config) commit whose diff touches packages/config', () =>
      runTest(
        Effect.gen(function* () {
          const context = fakeAnalyzeCommitsContext(
            [fakeCommit(hashConfigOnly, "feat(config): add a new config option")],
            repoDir,
          );

          const result = yield* Effect.promise(() => analyzeCommits({}, context));

          expect(result).toBe("minor");
        }),
      ));

    test("resolves null when the only commits are fix commits touching apps/cli, not packages/config", () =>
      runTest(
        Effect.gen(function* () {
          const context = fakeAnalyzeCommitsContext(
            [fakeCommit(hashCliOnly, "fix: correct an unrelated cli bug")],
            repoDir,
          );

          const result = yield* Effect.promise(() => analyzeCommits({}, context));

          expect(result).toBeNull();
        }),
      ));

    test('resolves "patch", not "major", because the breaking-change commit outside packages/config is filtered out', () =>
      runTest(
        Effect.gen(function* () {
          const context = fakeAnalyzeCommitsContext(
            [
              fakeCommit(hashConfigOnly, "fix: correct a bug in the config parser"),
              fakeCommit(
                hashCliOnly,
                "feat!: drop legacy cli flag\n\nBREAKING CHANGE: removes the legacy flag entirely",
              ),
            ],
            repoDir,
          );

          const result = yield* Effect.promise(() => analyzeCommits({}, context));

          expect(result).toBe("patch");
        }),
      ));
  });

  describe("generateNotes", () => {
    function fakeGenerateNotesContext(commits: Commit[], cwd: string): GenerateNotesContext {
      const base = fakeAnalyzeCommitsContext(commits, cwd);
      return {
        ...base,
        options: { ...base.options, repositoryUrl: "https://github.com/supabase/cli.git" },
        lastRelease: {
          version: "0.1.0",
          gitTag: "config-v0.1.0",
          channels: [],
          gitHead: commits[0]?.hash ?? "0".repeat(40),
          name: "config-v0.1.0",
        },
        nextRelease: {
          version: "0.2.0",
          gitTag: "config-v0.2.0",
          gitHead: commits[commits.length - 1]?.hash ?? "0".repeat(40),
          name: "config-v0.2.0",
          type: "minor",
          channel: "latest",
        },
      };
    }

    test("the notes mention the config commit and omit the commit that only touched apps/cli", () =>
      runTest(
        Effect.gen(function* () {
          const context = fakeGenerateNotesContext(
            [
              fakeCommit(hashConfigOnly, "feat(config): add a new config option"),
              fakeCommit(hashCliOnly, "fix(cli): unrelated cli bug that must not appear"),
            ],
            repoDir,
          );

          const notes = yield* Effect.promise(() => generateNotes({}, context));

          expect(notes).toContain("add a new config option");
          expect(notes).not.toContain("unrelated cli bug that must not appear");
        }),
      ));
  });
});
