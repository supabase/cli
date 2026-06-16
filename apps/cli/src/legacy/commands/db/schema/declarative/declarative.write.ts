import { Effect, type FileSystem, type Path } from "effect";

import { legacySplitAndTrim } from "../../../../shared/legacy-sql-split.ts";
import { LegacyDeclarativeWriteError } from "./declarative.errors.ts";
import type { LegacyDeclarativeOutput } from "./declarative.pgdelta.ts";

// `(?i)drop\s+` — Go's `dropStatementRegexp` (`declarative.go:62`).
const DROP_STATEMENT_PATTERN = /drop\s+/i;

/**
 * Extracts DROP statements from a migration diff for the safety warning shown
 * during sync. Mirrors Go's `findDropStatements` (`declarative.go:812`): split
 * the SQL into statements, then keep those matching `(?i)drop\s+`.
 */
export function legacyFindDropStatements(sql: string): ReadonlyArray<string> {
  return legacySplitAndTrim(sql).filter((statement) => DROP_STATEMENT_PATTERN.test(statement));
}

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
