import { Effect, FileSystem, Path } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { collectText } from "../../src/command-internal/container-cli.ts";

/**
 * Real git repositories for the tests that clone one, so `--template` is exercised
 * against git itself without reaching the network.
 */

/**
 * Runs `git` in `cwd`, dying with its stderr when it exits non-zero.
 *
 * Identity and configuration are pinned so a fixture does not depend on the
 * developer's own `~/.gitconfig` (or on there being one at all).
 */
export const runFixtureGit = Effect.fnUntraced(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const handle = yield* ChildProcess.make("git", [...args], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
    extendEnv: true,
  });
  const [exitCode, stderr] = yield* Effect.all(
    [handle.exitCode.pipe(Effect.map(Number)), collectText(handle.stderr)],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0) {
    return yield* Effect.die(`git ${args.join(" ")} failed: ${stderr}`);
  }
});

/**
 * A scoped temp directory holding `files`, committed once on `main`. The returned
 * absolute path is a repository location `git clone` accepts.
 */
export const makeGitRepo = Effect.fnUntraced(function* (files: Readonly<Record<string, string>>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-git-repo-" });

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(dir, relativePath);
    yield* fs.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fs.writeFileString(absolutePath, contents);
  }

  yield* Effect.scoped(runFixtureGit(dir, ["init", "--quiet", "--initial-branch=main"]));
  yield* Effect.scoped(runFixtureGit(dir, ["add", "-A"]));
  yield* Effect.scoped(runFixtureGit(dir, ["commit", "--quiet", "-m", "fixture"]));
  return dir;
});
