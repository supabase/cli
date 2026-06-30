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

/**
 * Records the pulled migration as applied in `supabase_migrations.schema_migrations`
 * WITHOUT re-executing it (the schema already exists on the remote). Mirrors Go's
 * `repair.UpdateMigrationTable(conn, [version], Applied, false, fsys)`
 * (`internal/migration/repair/repair.go:58`): create the history table, then UPSERT
 * the version row with the migration's name + statements.
 */
export const legacyUpdateMigrationHistory = (
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationPath: string,
  timestamp: string,
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const match = MIGRATE_FILE_PATTERN.exec(path.basename(migrationPath));
    if (match === null || match[1] !== timestamp) {
      // Go resolves the repair file by globbing `<timestamp>_*.sql` against the
      // migrations dir and fails with `os.ErrNotExist` when nothing matches
      // (`repair.GetMigrationFile`, `internal/migration/repair/repair.go:90-99`).
      // The glob is anchored on the GENERATED `timestamp` and `*` never crosses a
      // path separator, so a migration name with a separator (`supabase db pull
      // dir/...`) writes a nested file the glob can't reach — even when the nested
      // basename is itself a valid migration filename (`dir/20250101000000_backfill`
      // → basename `20250101000000_backfill.sql`, which DOES match the regex but
      // carries the user's nested timestamp, not the generated one). Require the
      // basename to both match the pattern AND carry the generated timestamp,
      // mirroring Go's anchored glob, rather than trusting `path.basename`.
      return yield* Effect.fail(
        new LegacyDbPullWriteError({
          message: `glob supabase/migrations/${timestamp}_*.sql: file does not exist`,
        }),
      );
    }
    // Guarded above: match[1] === timestamp, so use the generated timestamp
    // directly (avoids re-deriving a `string | undefined` from the regex group).
    const version = timestamp;
    const name = match[2] ?? "";
    yield* Effect.gen(function* () {
      const content = yield* fs.readFileString(migrationPath);
      const statements = legacySplitAndTrim(content);
      yield* legacyCreateMigrationTable(session);
      yield* session.query(UPSERT_MIGRATION_VERSION, [version, name, statements]);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDbPullWriteError({
            message: `failed to update migration table: ${cause.message}`,
          }),
      ),
    );
    // Match Go's `repair.UpdateMigrationTable(..., repairAll=false, ...)`, which
    // prints `Repaired migration history: [<version>] => applied` to stderr
    // (`internal/migration/repair/repair.go`). Plain text on stderr, so it does
    // not interfere with machine-output payloads on stdout.
    yield* output.raw(`Repaired migration history: [${version}] => applied\n`, "stderr");
  });
