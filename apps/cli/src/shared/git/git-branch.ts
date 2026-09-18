import { Effect, FileSystem, Option, Path } from "effect";

import { RuntimeInfo } from "../runtime/runtime-info.service.ts";

/**
 * Detects the current git branch: `$GITHUB_HEAD_REF` when set (CI
 * pull-request workflows), otherwise the nearest `.git/HEAD` walking up from
 * `startDir` (default: the runtime CWD), parsed as `ref: refs/heads/<name>`.
 * Returns `Option.none()` when no git repository is found; callers substitute
 * their own default.
 *
 * Pass `startDir` explicitly for a resolved `--workdir` so the branch
 * reflects the project directory, not the process's CWD.
 */
export const detectGitBranch = (
  startDir?: string,
): Effect.Effect<Option.Option<string>, never, RuntimeInfo | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const githubHeadRef = process.env["GITHUB_HEAD_REF"];
    if (githubHeadRef !== undefined && githubHeadRef.length > 0) {
      return Option.some(githubHeadRef);
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
