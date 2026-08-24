import { Config, Effect, FileSystem, Option, Path } from "effect";

import { RuntimeInfo } from "../runtime/runtime-info.service.ts";

/**
 * Reproduces `apps/cli-go/internal/utils/git.go:GetGitBranchOrDefault`:
 *
 * 1. `$GITHUB_HEAD_REF` wins when set (CI pull-request workflows).
 * 2. Otherwise walk from CWD up to the filesystem root reading `.git/HEAD`
 *    and parsing `ref: refs/heads/<name>`.
 *
 * Returns `Option.none()` when no git repository is detected. Callers may
 * substitute their own default (e.g. Go's `GetGitBranch` defaults to "main";
 * `branches create` defaults to the empty string so the prompt is skipped).
 *
 * `startDir` is the directory to begin the walk from; it defaults to the
 * runtime CWD. Commands that resolve a `--workdir` should pass it, because Go
 * chdirs into the workdir in `PersistentPreRunE` before calling `GetGitBranch`
 * (`cmd/root.go`), so the branch must reflect the project dir, not the caller's.
 */
export const detectGitBranch = (
  startDir?: string,
): Effect.Effect<Option.Option<string>, never, RuntimeInfo | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const githubHeadRef = yield* Config.option(Config.string("GITHUB_HEAD_REF")).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isSome(githubHeadRef) && githubHeadRef.value.length > 0) {
      return githubHeadRef;
    }

    const runtimeInfo = yield* RuntimeInfo;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    let dir = path.resolve(startDir ?? runtimeInfo.cwd);
    const root = path.parse(dir).root;

    while (true) {
      const headPath = path.join(dir, ".git", "HEAD");
      const content = yield* fs.readFileString(headPath).pipe(Effect.option);
      if (Option.isSome(content)) {
        const match = content.value.trim().match(/^ref: refs\/heads\/(.+)$/);
        return match?.[1] !== undefined ? Option.some(match[1]) : Option.none<string>();
      }
      if (dir === root) {
        return Option.none<string>();
      }
      dir = path.dirname(dir);
    }
  });
