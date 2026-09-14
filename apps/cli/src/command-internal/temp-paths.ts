import { Data, Effect, FileSystem, Option, type Path } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * A real failure reading `<workdir>/supabase/.temp/project-ref` (e.g. the
 * path is a directory, or permissions deny access) — distinct from the file
 * simply not existing, which means "not linked" rather than an error.
 */
export class ProjectRefReadError extends Data.TaggedError("ProjectRefReadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * Absolute paths to the established files under `<workdir>/supabase/.temp/`.
 * `supabase link`/`unlink` own writing and removing this directory; other
 * layers only read from it.
 */
export interface TempPaths {
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

export function tempPaths(path: Path.Path, workdir: string): TempPaths {
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
 * returning `None` when the file is absent or blank. A missing file means
 * "not linked"; any other read error (a directory, permission denied, …)
 * fails instead of being swallowed into an unlinked result.
 */
export const readProjectRefFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
): Effect.Effect<Option.Option<string>, ProjectRefReadError> =>
  Effect.gen(function* () {
    const refPath = tempPaths(path, workdir).projectRef;
    // A `NotFound` PlatformError means unlinked (fall through); any other
    // read error fails.
    const content = yield* fs.readFileString(refPath).pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed("")
          : Effect.fail(
              new ProjectRefReadError({
                message: `failed to load project ref: ${error.message}`,
              }),
            ),
      ),
    );
    const trimmed = content.trim();
    return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
  });
