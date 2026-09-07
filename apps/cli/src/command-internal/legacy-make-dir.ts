import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";

/**
 * `os.MkdirAll`-equivalent: create `dir` and any missing parents, treating an
 * already-existing directory as success.
 *
 * Go's `os.MkdirAll` returns nil when the target is already a directory, so the
 * Go CLI's migration writers never failed on a pre-existing `supabase/migrations`.
 * Effect's Bun `FileSystem.makeDirectory` does not always match that: even with
 * `recursive: true` it can surface an `AlreadyExists` `SystemError` for an
 * existing directory on some platforms (notably Windows / OneDrive reparse
 * points — see CLI-1849). Recover from that single reason so re-creating an
 * existing directory is a no-op, and let every other failure propagate.
 */
export const legacyMakeDir = (
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
