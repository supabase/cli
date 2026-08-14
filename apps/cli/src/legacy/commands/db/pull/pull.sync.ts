import { Effect, type FileSystem, type Path } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import {
  MIGRATE_FILE_PATTERN,
  UPSERT_MIGRATION_VERSION,
  legacyCreateMigrationTable,
} from "../../../shared/legacy-migration-history.ts";
import { legacySplitAndTrim } from "../../../shared/legacy-sql-split.ts";
import { LegacyDbPullWriteError } from "./pull.errors.ts";

/** A pulled migration file paired with the version to record in the history. */
export interface LegacyPulledMigration {
  readonly path: string;
  readonly version: string;
}

/**
 * Records the pulled migration(s) as applied in
 * `supabase_migrations.schema_migrations` WITHOUT re-executing them (the schema
 * already exists on the remote): create the history table, then UPSERT each
 * version row with the migration's name + statements. A pg-delta pull whose
 * plan crosses a transaction boundary writes several ordered files, so several
 * versions are recorded in one pass.
 */
export const legacyUpdateMigrationHistory = (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrations: ReadonlyArray<LegacyPulledMigration>,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    // Resolve each file by globbing `<version>_*.sql` against the migrations dir,
    // failing when nothing matches. The glob is anchored on the GENERATED version
    // and `*` never crosses a path separator, so a migration name with a separator
    // writes a nested file the glob can't reach — require the basename to both
    // match the pattern AND carry the generated version rather than trusting
    // `path.basename`.
    const resolved: Array<{ version: string; name: string; migrationPath: string }> = [];
    for (const migration of migrations) {
      const match = MIGRATE_FILE_PATTERN.exec(path.basename(migration.path));
      if (match === null || match[1] !== migration.version) {
        return yield* Effect.fail(
          new LegacyDbPullWriteError({
            message: `glob supabase/migrations/${migration.version}_*.sql: file does not exist`,
          }),
        );
      }
      resolved.push({
        version: migration.version,
        name: match[2] ?? "",
        migrationPath: migration.path,
      });
    }
    yield* Effect.gen(function* () {
      // Create the history schema/table first, in its OWN transaction. Keeping it
      // outside the upsert transaction below avoids nesting BEGINs
      // (`legacyCreateMigrationTable` issues its own BEGIN/COMMIT).
      yield* legacyCreateMigrationTable(session);
      // Record every version in ONE explicit transaction: a mid-loop failure
      // (dropped connection, unreadable migration file) must record NONE of them.
      // Without a transaction here each UPSERT autocommits, so a failure partway
      // through would leave partial remote history that fails the next pull's
      // sync check.
      yield* Effect.gen(function* () {
        yield* session.exec("BEGIN");
        for (const entry of resolved) {
          const content = yield* fs.readFileString(entry.migrationPath);
          const statements = legacySplitAndTrim(content);
          yield* session.query(UPSERT_MIGRATION_VERSION, [entry.version, entry.name, statements]);
        }
        yield* session.exec("COMMIT");
      }).pipe(
        // Roll back on ANY failure inside the transaction — including a migration
        // file read that fails after BEGIN. `Effect.ignore` keeps a ROLLBACK
        // failure from masking the original error (`tapError` re-raises the
        // original). Mirrors `legacyCreateMigrationTable`'s rollback handling.
        Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDbPullWriteError({
            message: `failed to update migration table: ${cause.message}`,
          }),
      ),
    );
    // Prints `Repaired migration history: [<v1> <v2> ...] => applied` to stderr
    // (established output contract; space-separated versions). Plain text on
    // stderr, so it does not interfere with machine-output payloads on stdout.
    const versions = resolved.map((entry) => entry.version).join(" ");
    yield* output.raw(`Repaired migration history: [${versions}] => applied\n`, "stderr");
  });
