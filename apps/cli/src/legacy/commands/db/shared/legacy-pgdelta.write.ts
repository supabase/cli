import { Effect, type FileSystem, type Path } from "effect";

import { LegacyDeclarativeWriteError } from "./legacy-pgdelta.errors.ts";
import type { LegacyDeclarativeOutput } from "./legacy-pgdelta.ts";

/**
 * Materializes pg-delta declarative export output under the declarative dir.
 * Mirrors Go's `WriteDeclarativeSchemas` (`declarative.go:239`): wipe the dir,
 * recreate it, and write each file at its (path-safe) relative path.
 *
 * Go also updates `[db.migrations] schema_paths` afterwards, but only when
 * pg-delta is *disabled* (`if utils.IsPgDeltaEnabled() { return nil }`).
 * Declarative commands require pg-delta enabled (the gate), so that branch is
 * unreachable here and is intentionally not ported.
 */
export const legacyWriteDeclarativeSchemas = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  declarativeDir: string,
  output: LegacyDeclarativeOutput,
) {
  yield* fs.remove(declarativeDir, { recursive: true }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      // Go wraps any failure; a missing dir is fine (we recreate it next).
      error.reason._tag === "NotFound"
        ? Effect.void
        : Effect.fail(
            new LegacyDeclarativeWriteError({
              message: `failed to clean declarative schema directory: ${error.message}`,
            }),
          ),
    ),
  );
  yield* fs.makeDirectory(declarativeDir, { recursive: true });

  for (const file of output.files) {
    const rel = path.normalize(file.path);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return yield* Effect.fail(
        new LegacyDeclarativeWriteError({
          message: `unsafe declarative export path: ${file.path}`,
        }),
      );
    }
    const targetPath = path.join(declarativeDir, rel);
    yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
    yield* fs.writeFileString(targetPath, file.sql);
  }
});
