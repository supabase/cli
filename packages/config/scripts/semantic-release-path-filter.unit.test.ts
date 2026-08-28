import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...GIT_HERMETIC_CONFIG, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
  return stdout;
}

async function commitFiles(
  cwd: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(cwd, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
  await git(cwd, ["add", ...Object.keys(files)]);
  await git(cwd, ["commit", "-m", message]);
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
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
// VerifyConditionsContext/BaseContext, but analyzeCommits() (ours and the
// real commit-analyzer it delegates to) only reads commits/cwd/logger.log;
// the rest is dummy filler required purely to satisfy the type.
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

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "semantic-release-path-filter-"));
    await git(repoDir, ["init", "-b", "main", "-q"]);

    // Seed a plain root commit so the main scenario commits all exercise the
    // ordinary (parented) diff path; the root-commit case (`--root`) has its
    // own dedicated test below.
    await commitFiles(repoDir, { "README.md": "seed\n" }, "chore: seed repo root commit");

    hashConfigOnly = await commitFiles(
      repoDir,
      { "packages/config/src/foo.ts": "export const foo = 1;\n" },
      "chore: seed packages/config/src/foo.ts",
    );
    hashCliOnly = await commitFiles(
      repoDir,
      { "apps/cli/src/bar.ts": "export const bar = 1;\n" },
      "chore: seed apps/cli/src/bar.ts",
    );
    hashBoth = await commitFiles(
      repoDir,
      {
        "packages/config/src/foo2.ts": "export const foo2 = 1;\n",
        "apps/cli/src/bar2.ts": "export const bar2 = 1;\n",
      },
      "chore: seed both packages/config and apps/cli files",
    );
    hashPrefixTrap = await commitFiles(
      repoDir,
      { "packages/config-other/x.ts": "export const x = 1;\n" },
      "chore: seed packages/config-other, a prefix-adjacent trap",
    );
    hashNonAsciiPath = await commitFiles(
      repoDir,
      { "packages/config/src/café.ts": "export const café = 1;\n" },
      "chore: seed a non-ASCII path under packages/config",
    );

    await git(repoDir, ["checkout", "-b", "feature", "-q"]);
    await commitFiles(
      repoDir,
      { "packages/config/src/on-branch.ts": "export const onBranch = 1;\n" },
      "chore: seed a commit on the feature branch",
    );
    await git(repoDir, ["checkout", "main", "-q"]);
    await git(repoDir, ["merge", "--no-ff", "feature", "-m", "merge: merge feature branch"]);
    hashMerge = (await git(repoDir, ["rev-parse", "HEAD"])).trim();
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  test("PACKAGE_PATH_PREFIX is the packages/config/ prefix the release train filters commits against", () => {
    expect(PACKAGE_PATH_PREFIX).toBe("packages/config/");
  });

  describe("filterCommitsToPackage", () => {
    test("keeps only commits whose diff touches packages/config/**, preserving the input's order", async () => {
      const shuffledInput = [hashCliOnly, hashBoth, hashPrefixTrap, hashMerge, hashConfigOnly].map(
        (hash) => ({
          hash,
        }),
      );

      const result = await filterCommitsToPackage(shuffledInput, repoDir);

      expect(result).toEqual([{ hash: hashBoth }, { hash: hashConfigOnly }]);
    });

    test("excludes a merge commit even though the branch it merged touched packages/config/**", async () => {
      const result = await filterCommitsToPackage([{ hash: hashMerge }], repoDir);

      expect(result).toEqual([]);
    });

    test("does not treat packages/config-other/ as a match for the packages/config/ prefix", async () => {
      const result = await filterCommitsToPackage([{ hash: hashPrefixTrap }], repoDir);

      expect(result).toEqual([]);
    });

    test("returns an empty array for empty input", async () => {
      const result = await filterCommitsToPackage([], repoDir);

      expect(result).toEqual([]);
    });

    test("includes a commit whose only config path is non-ASCII (core.quotePath would C-quote it without -z)", async () => {
      const result = await filterCommitsToPackage([{ hash: hashNonAsciiPath }], repoDir);

      expect(result).toEqual([{ hash: hashNonAsciiPath }]);
    });

    test("includes a root commit that touches packages/config/** (--root diffs it against the empty tree)", async () => {
      const rootRepoDir = await mkdtemp(join(tmpdir(), "semantic-release-path-filter-root-"));
      try {
        await git(rootRepoDir, ["init", "-b", "main", "-q"]);
        const rootHash = await commitFiles(
          rootRepoDir,
          { "packages/config/src/first.ts": "export const first = 1;\n" },
          "chore: repo root commit touching packages/config",
        );

        const result = await filterCommitsToPackage([{ hash: rootHash }], rootRepoDir);

        expect(result).toEqual([{ hash: rootHash }]);
      } finally {
        await rm(rootRepoDir, { recursive: true, force: true });
      }
    });

    test("rejects with a descriptive error when git diff-tree exits non-zero", async () => {
      const notARepo = await mkdtemp(join(tmpdir(), "semantic-release-path-filter-not-a-repo-"));
      try {
        await expect(filterCommitsToPackage([{ hash: "a".repeat(40) }], notARepo)).rejects.toThrow(
          /^git diff-tree --stdin failed with exit code 128: /,
        );
      } finally {
        await rm(notARepo, { recursive: true, force: true });
      }
    });
  });

  describe("analyzeCommits", () => {
    test('resolves "minor" for a feat(config) commit whose diff touches packages/config', async () => {
      const context = fakeAnalyzeCommitsContext(
        [fakeCommit(hashConfigOnly, "feat(config): add a new config option")],
        repoDir,
      );

      const result = await analyzeCommits({}, context);

      expect(result).toBe("minor");
    });

    test("resolves null when the only commits are fix commits touching apps/cli, not packages/config", async () => {
      const context = fakeAnalyzeCommitsContext(
        [fakeCommit(hashCliOnly, "fix: correct an unrelated cli bug")],
        repoDir,
      );

      const result = await analyzeCommits({}, context);

      expect(result).toBeNull();
    });

    test('resolves "patch", not "major", because the breaking-change commit outside packages/config is filtered out', async () => {
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

      const result = await analyzeCommits({}, context);

      expect(result).toBe("patch");
    });
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

    test("the notes mention the config commit and omit the commit that only touched apps/cli", async () => {
      const context = fakeGenerateNotesContext(
        [
          fakeCommit(hashConfigOnly, "feat(config): add a new config option"),
          fakeCommit(hashCliOnly, "fix(cli): unrelated cli bug that must not appear"),
        ],
        repoDir,
      );

      const notes = await generateNotes({}, context);

      expect(notes).toContain("add a new config option");
      expect(notes).not.toContain("unrelated cli bug that must not appear");
    });
  });
});
