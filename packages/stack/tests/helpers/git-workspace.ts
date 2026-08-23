// oxlint-disable effecttsgo/node-builtin-import -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real git repositories in temporary directories, for the suites that exercise
 * the managed layer's git identity and isolation rules.
 *
 * These are built with the git binary rather than by writing metadata by hand:
 * the whole reason identity is stored where git stores it is that git's own
 * lifecycle rules — worktree layout, config inheritance, branch renames, what a
 * clone copies — do the work, and none of those rules can be observed against a
 * stub.
 */

const GIT_ENV = {
  ...process.env,
  // Isolated from the developer's own git configuration, which could otherwise
  // decide the initial branch name or sign the fixture commits.
  HOME: devNull,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Managed Stack Test",
  GIT_AUTHOR_EMAIL: "managed@example.test",
  GIT_COMMITTER_NAME: "Managed Stack Test",
  GIT_COMMITTER_EMAIL: "managed@example.test",
};

export const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8", env: GIT_ENV });

/** What `git config` reports for `key`, bypassing this package's own store. */
export const storedConfigValue = (file: string, key: string): string | undefined => {
  try {
    return git(".", "config", "--file", file, "--get", key).trim();
  } catch {
    return undefined;
  }
};

export const makeDirectory = (root: string, name: string): string => {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  return directory;
};

/** A primary checkout with one commit on `main`. */
export const makeRepository = (root: string, name = "repo"): string => {
  const repository = makeDirectory(root, name);
  git(repository, "init", "-q", "-b", "main");
  git(repository, "commit", "-q", "--allow-empty", "-m", "init");
  return repository;
};

/** A bare clone of `source`, which has worktrees but no working tree of its own. */
export const makeBareRepository = (root: string, source: string, name = "bare.git"): string => {
  git(root, "clone", "-q", "--bare", source, name);
  return join(root, name);
};

/**
 * Temporary roots one test file owns, removed together. Canonicalized on
 * creation, because every inspection reports canonical paths and the platform
 * temporary directory is a symlink on macOS.
 */
export const temporaryRoots = (
  prefix: string,
): { readonly makeRoot: () => string; readonly removeAll: () => void } => {
  const roots: Array<string> = [];
  return {
    makeRoot: () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
      roots.push(root);
      return root;
    },
    removeAll: () => {
      for (const root of roots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
      }
    },
  };
};
