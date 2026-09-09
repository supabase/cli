import { basename, dirname } from "node:path";
import { Effect, Option } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { collectText } from "./container-cli.ts";

/**
 * Whether `path` — a file OR a directory — has uncommitted changes in its git
 * working tree. Backs `config pull`'s own dirty guard (CLI-2064 plan §1.4)
 * over `supabase/config.toml`, and `pull`'s own generalized dirty guard
 * (CLI-1272) over `supabase/config.toml`, `supabase/migrations`, and
 * `supabase/functions`: each command warns (TTY, no `--force`) or aborts
 * (machine format, no `--force`) before silently overwriting local edits.
 *
 * Runs `git status --porcelain -- <basename>` with `cwd` set to `path`'s own
 * parent directory (reusing `spawn`/`collectText` exactly as
 * `container-cli.ts`'s `containerCliExitCodeAndStdout` does) — the path
 * argument is always the bare basename, listed after `--`, so a name that
 * happens to look like a flag is never misread as one. Git's own pathspec
 * matching already treats a directory pathspec as "anything under that
 * tree", so passing a directory here needs no special-casing: a non-empty
 * result means at least one file under it is modified or untracked.
 *
 * git plumbing here is advisory, never load-bearing, mirroring
 * `detectGitBranch`'s (`../../shared/git/git-branch.ts`) own
 * degrade-silently philosophy: `Option.none()` covers every case that isn't a
 * clean yes/no answer — `path`'s parent directory isn't a git working tree,
 * `git` isn't installed or isn't on `PATH` (spawn failure), `git status`
 * exits non-zero for any other reason, or the command otherwise fails for any
 * reason — so a caller never needs to distinguish "definitely clean" from
 * "couldn't tell". `Option.some(true)` is a non-empty porcelain output
 * (uncommitted changes exist); `Option.some(false)` is an exit-0 run with
 * empty output (clean working tree).
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
