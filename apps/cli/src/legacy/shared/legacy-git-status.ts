import { basename, dirname } from "node:path";
import { Effect, Option } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { legacyCollectText } from "./legacy-container-cli.ts";

/**
 * Whether `filePath` has uncommitted changes in its git working tree — backs
 * `config pull`'s dirty guard (CLI-2064 plan §1.4): the command warns (TTY,
 * no `--force`) or aborts (machine format, no `--force`) before silently
 * overwriting local edits to `supabase/config.toml`.
 *
 * Runs `git status --porcelain -- <basename>` with `cwd` set to `filePath`'s
 * own directory (reusing `spawn`/`legacyCollectText` exactly as
 * `legacy-container-cli.ts`'s `legacyContainerCliExitCodeAndStdout` does) —
 * the file argument is always the bare basename, listed after `--`, so a
 * filename that happens to look like a flag is never misread as one.
 *
 * git plumbing here is advisory, never load-bearing, mirroring
 * `detectGitBranch`'s (`../../shared/git/git-branch.ts`) own
 * degrade-silently philosophy: `Option.none()` covers every case that isn't a
 * clean yes/no answer — `filePath`'s directory isn't a git working tree, `git`
 * isn't installed or isn't on `PATH` (spawn failure), `git status` exits
 * non-zero for any other reason, or the command otherwise fails for any
 * reason — so a caller never needs to distinguish "definitely clean" from
 * "couldn't tell". `Option.some(true)` is a non-empty porcelain output
 * (uncommitted changes exist); `Option.some(false)` is an exit-0 run with
 * empty output (clean working tree).
 */
export function legacyConfigFileHasUncommittedChanges(
  filePath: string,
): Effect.Effect<Option.Option<boolean>, never, ChildProcessSpawner> {
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["status", "--porcelain", "--", basename(filePath)], {
          cwd: dirname(filePath),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }),
      );
      const [exitCode, stdout] = yield* Effect.all(
        [handle.exitCode.pipe(Effect.map(Number)), legacyCollectText(handle.stdout)],
        { concurrency: "unbounded" },
      );
      return exitCode === 0 ? Option.some(stdout.trim().length > 0) : Option.none<boolean>();
    }),
  ).pipe(Effect.orElseSucceed(() => Option.none<boolean>()));
}
