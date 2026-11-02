import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";

/**
 * Creates `dir` and any missing parents, treating an already-existing directory as success.
 *
 * Effect's Bun `FileSystem.makeDirectory` can surface an `AlreadyExists` `SystemError` for an
 * existing directory even with `recursive: true`, on some platforms (notably Windows/OneDrive
 * reparse points) — that single reason is treated as a no-op, and every other failure propagates.
 */
export const makeDir = (
  fs: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<void, PlatformError> =>
  fs
    .makeDirectory(dir, { recursive: true })
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
      ),
    );
