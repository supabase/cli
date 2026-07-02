import { Effect, FileSystem, Path } from "effect";
import { findGitRootPath } from "../../shared/git/git-root.ts";

const GITIGNORE_ENTRY = ".supabase/";

const normalizeGitignoreEntry = (entry: string): string => entry.replaceAll("\\", "/");

export const ensureProjectStateIgnored = (
  projectRoot: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitRoot = yield* Effect.tryPromise(() => findGitRootPath(projectRoot)).pipe(Effect.orDie);

    if (gitRoot === undefined) {
      return;
    }

    const relativeProjectPath = normalizeGitignoreEntry(path.relative(gitRoot, projectRoot));
    const entry =
      relativeProjectPath === "" ? GITIGNORE_ENTRY : `${relativeProjectPath}/${GITIGNORE_ENTRY}`;
    const gitignorePath = path.join(gitRoot, ".gitignore");
    const existing = (yield* fs.exists(gitignorePath).pipe(Effect.orDie))
      ? yield* fs.readFileString(gitignorePath).pipe(Effect.orDie)
      : "";
    const lines = existing
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.includes(entry) || lines.includes(`/${entry}`)) {
      return;
    }

    const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
    yield* fs.writeFileString(gitignorePath, `${prefix}${entry}\n`).pipe(Effect.orDie);
  });
