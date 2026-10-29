import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path, type PlatformError } from "effect";

import { gitOrThrow, makeGit } from "./promotion-shared.ts";

/* Synchronous like the runner under test, which calls racing tests' git wrappers synchronously. */
export function git(cwd: string, ...args: string[]): string {
  return gitOrThrow(makeGit(cwd), ["-c", "core.hooksPath=/dev/null", ...args]);
}

export function runEffect<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  );
}

export interface TestRepo {
  remote: string;
  seed: string;
  /** Clone of the remote taken on demand, the way a workflow checkout is. */
  checkout(): string;
  commit(
    cwd: string,
    file: string,
    contents: string,
    message: string,
  ): Effect.Effect<string, PlatformError.PlatformError>;
  remoteTip(branch: string): string;
  isAncestor(ancestor: string, descendant: string): boolean;
  cleanup: Effect.Effect<void, PlatformError.PlatformError>;
}

/** A bare remote plus a seed clone with `main` holding one commit. */
export const createTestRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ prefix: "promotion-" });
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");

  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "main", seed);
  git(seed, "config", "user.name", "Promotion Test");
  git(seed, "config", "user.email", "promotion@example.test");
  git(seed, "remote", "add", "origin", remote);

  const commit = Effect.fnUntraced(function* (
    cwd: string,
    file: string,
    contents: string,
    message: string,
  ) {
    yield* fs.writeFileString(join(cwd, file), contents);
    git(cwd, "add", file);
    git(cwd, "commit", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  });
  yield* commit(seed, "shared.txt", "base\n", "chore: base");
  git(seed, "push", "origin", "main");

  let clones = 0;
  const repo: TestRepo = {
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
    cleanup: fs.remove(root, { recursive: true, force: true }),
  };
  return repo;
});
