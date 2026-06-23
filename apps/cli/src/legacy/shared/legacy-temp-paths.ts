import { Data, Effect, FileSystem, Option, type Path } from "effect";

/**
 * A real failure reading `<workdir>/supabase/.temp/project-ref` (e.g. the path is a
 * directory or permissions deny access). Mirrors Go's `flags.LoadProjectRef`, which
 * returns `failed to load project ref: <err>` for any non-not-exist read error
 * (`apps/cli-go/internal/utils/flags/project_ref.go:71-72`) rather than treating it
 * as an unlinked project.
 */
export class LegacyProjectRefReadError extends Data.TaggedError("LegacyProjectRefReadError")<{
  readonly message: string;
}> {}

/**
 * Absolute paths to the files the Go CLI writes under `<workdir>/supabase/.temp/`.
 * Mirrors the `utils.*Path` constants in `apps/cli-go/internal/utils/misc.go:84-98`.
 *
 * `supabase link` / `supabase unlink` are the authoritative writers and remover
 * of this directory, but several layers (`legacy-project-ref.layer.ts`,
 * `legacy-linked-project-cache.layer.ts`) also read from it. Centralising the
 * joins here keeps the path layout in one place instead of re-inlining
 * `path.join(workdir, "supabase", ".temp", "...")` at every call site.
 */
export interface LegacyTempPaths {
  readonly tempDir: string;
  readonly projectRef: string;
  readonly poolerUrl: string;
  readonly postgresVersion: string;
  readonly restVersion: string;
  readonly gotrueVersion: string;
  readonly storageVersion: string;
  readonly storageMigration: string;
  readonly pgmetaVersion: string;
  readonly linkedProjectCache: string;
}

export function legacyTempPaths(path: Path.Path, workdir: string): LegacyTempPaths {
  const tempDir = path.join(workdir, "supabase", ".temp");
  return {
    tempDir,
    projectRef: path.join(tempDir, "project-ref"),
    poolerUrl: path.join(tempDir, "pooler-url"),
    postgresVersion: path.join(tempDir, "postgres-version"),
    restVersion: path.join(tempDir, "rest-version"),
    gotrueVersion: path.join(tempDir, "gotrue-version"),
    storageVersion: path.join(tempDir, "storage-version"),
    storageMigration: path.join(tempDir, "storage-migration"),
    pgmetaVersion: path.join(tempDir, "pgmeta-version"),
    linkedProjectCache: path.join(tempDir, "linked-project.json"),
  };
}

/**
 * Reads the linked project ref from `<workdir>/supabase/.temp/project-ref`,
 * returning `None` when the file is absent or blank. Mirrors the non-prompting
 * file read in Go's `flags.LoadProjectRef` (`project_ref.go:67-72`): a single read
 * where a not-exist file is "not linked" (→ `None`), but any other read error (the
 * path is a directory, permission denied, …) surfaces `failed to load project ref`
 * rather than being swallowed into an unlinked result. Shared by the project-ref
 * resolver and the declarative smart-generate prompt so both detect a linked workdir
 * — and a broken one — the same way.
 */
export const legacyReadProjectRefFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
): Effect.Effect<Option.Option<string>, LegacyProjectRefReadError> =>
  Effect.gen(function* () {
    const refPath = legacyTempPaths(path, workdir).projectRef;
    // One read, mirroring Go's single `afero.ReadFile`. Effect surfaces not-exist as
    // a `PlatformError` with a `SystemError` reason tagged `"NotFound"` → treat as the
    // unlinked/fall-through case; every other read error fails (Go's `errors.Errorf`).
    const content = yield* fs.readFileString(refPath).pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed("")
          : Effect.fail(
              new LegacyProjectRefReadError({
                message: `failed to load project ref: ${error.message}`,
              }),
            ),
      ),
    );
    const trimmed = content.trim();
    return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
  });
