import { Effect, type FileSystem, type Path } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import type { DbSession } from "../../../command-internal/db-connection.service.ts";
import {
  MIGRATE_FILE_PATTERN,
  UPSERT_MIGRATION_VERSION,
  createMigrationTable,
} from "../../../command-internal/migration-history.ts";
import { splitAndTrim } from "../../../command-internal/sql-split.ts";
import { DbPullWriteError } from "./pull.errors.ts";

/** A pulled migration file paired with the version to record in the history. */
export interface PulledMigration {
  readonly path: string;
  readonly version: string;
}

/**
 * Records the pulled migration(s) as applied in `supabase_migrations.schema_migrations`
 * without re-executing them (the schema already exists on the remote): creates the
 * history table, then upserts each version row with the migration's name + statements.
 * A pg-delta pull whose plan crosses a transaction boundary writes several files, so
 * several versions are recorded in one pass.
 */
export const updateMigrationHistory = (
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrations: ReadonlyArray<PulledMigration>,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    // The glob (`<version>_*.sql`) never crosses a path separator, so a migration name
    // with one writes a nested file it can't reach — require the basename to both match
    // the pattern and carry the generated version, rather than trusting `path.basename`.
    const resolved: Array<{ version: string; name: string; migrationPath: string }> = [];
    for (const migration of migrations) {
      const match = MIGRATE_FILE_PATTERN.exec(path.basename(migration.path));
      if (match === null || match[1] !== migration.version) {
        return yield* Effect.fail(
          new DbPullWriteError({
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
      // Created in its own transaction, outside the upsert transaction below, to avoid
      // nesting BEGINs (`createMigrationTable` issues its own BEGIN/COMMIT).
      yield* createMigrationTable(session);
      // One explicit transaction: without it, each UPSERT autocommits, so a mid-loop
      // failure would leave partial remote history that fails the next pull's sync check.
      yield* Effect.gen(function* () {
        yield* session.exec("BEGIN");
        for (const entry of resolved) {
          const content = yield* fs.readFileString(entry.migrationPath);
          const statements = splitAndTrim(content);
          yield* session.query(UPSERT_MIGRATION_VERSION, [entry.version, entry.name, statements]);
        }
        yield* session.exec("COMMIT");
      }).pipe(
        // `Effect.ignore` keeps a ROLLBACK failure from masking the original error
        // (`tapError` re-raises it); mirrors `createMigrationTable`'s rollback handling.
        Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DbPullWriteError({
            message: `failed to update migration table: ${cause.message}`,
          }),
      ),
    );
    // Established output contract; printed to stderr so it never interferes with a
    // machine-output payload on stdout.
    const versions = resolved.map((entry) => entry.version).join(" ");
    yield* output.raw(`Repaired migration history: [${versions}] => applied\n`, "stderr");
  });
