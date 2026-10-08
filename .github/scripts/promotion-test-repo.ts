import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export interface TestRepo {
  remote: string;
  seed: string;
  /** Clone of the remote taken on demand, the way a workflow checkout is. */
  checkout(): string;
  commit(cwd: string, file: string, contents: string, message: string): string;
  remoteTip(branch: string): string;
  isAncestor(ancestor: string, descendant: string): boolean;
  cleanup(): void;
}

/** A bare remote plus a seed clone with `main` holding one commit. */
export function createTestRepo(): TestRepo {
  const root = mkdtempSync(join(tmpdir(), "promotion-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");

  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "main", seed);
  git(seed, "config", "user.name", "Promotion Test");
  git(seed, "config", "user.email", "promotion@example.test");
  git(seed, "remote", "add", "origin", remote);

  const commit = (cwd: string, file: string, contents: string, message: string): string => {
    writeFileSync(join(cwd, file), contents);
    git(cwd, "add", file);
    git(cwd, "commit", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  commit(seed, "shared.txt", "base\n", "chore: base");
  git(seed, "push", "origin", "main");

  let clones = 0;
  return {
    remote,
    seed,
    commit,
    checkout() {
      clones += 1;
      const path = join(root, `checkout-${clones}`);
      git(root, "clone", remote, path);
      git(path, "config", "user.name", "Promotion Test");
      git(path, "config", "user.email", "promotion@example.test");
      return path;
    },
    remoteTip: (branch) => git(remote, "rev-parse", `refs/heads/${branch}`),
    isAncestor(ancestor, descendant) {
      try {
        git(remote, "merge-base", "--is-ancestor", ancestor, descendant);
        return true;
      } catch {
        return false;
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
