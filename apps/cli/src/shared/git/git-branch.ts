import { Effect, FileSystem, Option, Path } from "effect";

import { RuntimeInfo } from "../runtime/runtime-info.service.ts";

/**
 * Detects the current git branch: `$GITHUB_HEAD_REF` when set (CI
 * pull-request workflows), otherwise the nearest `.git` walking up from
 * `startDir` (default: the runtime CWD). Returns `Option.none()` when no git
 * repository is found, its HEAD is detached, or its branch can't otherwise be
 * determined; callers substitute their own default.
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

    const branchFromHead = (content: string): Option.Option<string> => {
      const match = content.trim().match(/^ref: refs\/heads\/(.+)$/);
      return match?.[1] !== undefined ? Option.some(match[1]) : Option.none<string>();
    };

    // Reads `HEAD` in `gitDir` and parses it — `Option.none()` covers both a
    // missing/unreadable file and a detached HEAD (a raw commit SHA).
    const readBranch = (gitDir: string) =>
      fs
        .readFileString(path.join(gitDir, "HEAD"))
        .pipe(Effect.option, Effect.map(Option.flatMap(branchFromHead)));

    let dir = path.resolve(startDir ?? runtimeInfo.cwd);
    const root = path.parse(dir).root;

    while (true) {
      const gitPath = path.join(dir, ".git");
      const info = yield* fs.stat(gitPath).pipe(Effect.option);
      if (Option.isSome(info)) {
        // Found the repository root — resolve its branch here and stop, even on
        // failure, rather than walking into an unrelated parent checkout.
        if (info.value.type === "Directory") {
          return yield* readBranch(gitPath);
        }
        // A `.git` FILE is a worktree/submodule gitlink: `gitdir: <path>`, the
        // path resolved relative to `dir` when it isn't already absolute.
        const gitlink = yield* fs.readFileString(gitPath).pipe(Effect.option);
        const target = gitlink.pipe(
          Option.flatMap((raw) => Option.fromNullishOr(raw.trim().match(/^gitdir:\s*(.+)$/)?.[1])),
        );
        if (Option.isNone(target)) {
          return Option.none<string>();
        }
        const gitDir = path.isAbsolute(target.value)
          ? target.value
          : path.resolve(dir, target.value);
        return yield* readBranch(gitDir);
      }
      if (dir === root) {
        return Option.none<string>();
      }
      dir = path.dirname(dir);
    }
  });

/**
 * Renders " on branch <name>" for a "Finished …" summary line, or an empty
 * string when the branch is unknown — never guess a default like `main`.
 */
export const branchClause = (branch: Option.Option<string>, format: (name: string) => string) =>
  Option.match(branch, { onNone: () => "", onSome: (name) => ` on branch ${format(name)}` });
