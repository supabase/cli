import { Effect, FileSystem, Path } from "effect";

const GITIGNORE_ENTRY = ".supabase/";

const normalizeGitignoreEntry = (entry: string): string => entry.replaceAll("\\", "/");

const findGitRoot = (
  start: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    let current = path.resolve(start);
    const root = path.parse(current).root;

    while (true) {
      const gitPath = path.join(current, ".git");
      if (yield* fs.exists(gitPath).pipe(Effect.orDie)) {
        return current;
      }
      if (current === root) {
        return null;
      }
      current = path.dirname(current);
    }
  });

export const ensureProjectStateIgnored = (
  projectRoot: string,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitRoot = yield* findGitRoot(projectRoot);

    if (gitRoot === null) {
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
