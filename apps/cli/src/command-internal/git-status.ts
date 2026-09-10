import { basename, dirname } from "node:path";
import { Effect, Option } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { collectText } from "./container-cli.ts";

/**
 * Whether `path` (a file or directory) has uncommitted changes in its git working tree.
 *
 * Runs `git status --porcelain -- <basename>` with `cwd` set to `path`'s parent directory, listing
 * the basename after `--` so a name that looks like a flag isn't misread as one. A directory
 * pathspec matches anything under that tree, so a non-empty result means at least one file under
 * it is modified or untracked.
 *
 * Returns `Option.none()` whenever the answer can't be determined (not a git working tree, `git`
 * missing, a non-zero exit, or any other failure) rather than treating that as "clean".
 */
export function pathHasUncommittedChanges(
  path: string,
): Effect.Effect<Option.Option<boolean>, never, ChildProcessSpawner> {
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["status", "--porcelain", "--", basename(path)], {
          cwd: dirname(path),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }),
      );
      const [exitCode, stdout] = yield* Effect.all(
        [handle.exitCode.pipe(Effect.map(Number)), collectText(handle.stdout)],
        { concurrency: "unbounded" },
      );
      return exitCode === 0 ? Option.some(stdout.trim().length > 0) : Option.none<boolean>();
    }),
  ).pipe(Effect.orElseSucceed(() => Option.none<boolean>()));
}
