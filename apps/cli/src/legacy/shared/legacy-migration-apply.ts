import { Effect, type FileSystem, type Path } from "effect";

import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { legacySplitAndTrim } from "./legacy-sql-split.ts";

/**
 * Migration-history DDL/DML, verbatim from Go's `pkg/migration/history.go`.
 */
const SET_LOCK_TIMEOUT = "SET lock_timeout = '4s'";
const CREATE_VERSION_SCHEMA = "CREATE SCHEMA IF NOT EXISTS supabase_migrations";
const CREATE_VERSION_TABLE =
  "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY)";
const ADD_STATEMENTS_COLUMN =
  "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[]";
const ADD_NAME_COLUMN =
  "ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text";
const INSERT_MIGRATION_VERSION =
  "INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES($1, $2, $3)";

// `pkg/migration/file.go` — `<digits>_<name>.sql`.
const MIGRATE_FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/;

/** Creates the migration-history schema/table (idempotent). Go's `CreateMigrationTable`. */
const createMigrationTable = (session: LegacyDbSession) =>
  Effect.gen(function* () {
    yield* session.exec(SET_LOCK_TIMEOUT);
    yield* session.exec(CREATE_VERSION_SCHEMA);
    yield* session.exec(CREATE_VERSION_TABLE);
    yield* session.exec(ADD_STATEMENTS_COLUMN);
    yield* session.exec(ADD_NAME_COLUMN);
  });

/**
 * Applies a single migration file to the connected database and records it in
 * `supabase_migrations.schema_migrations`. Mirrors Go's `migration.ApplyMigrations`
 * for one file (`pkg/migration/apply.go` + `(*MigrationFile).ExecBatch`): create
 * the history table, `RESET ALL`, then run the file's statements + the history
 * insert atomically. The whole file is one transaction (Go's `ExecBatch` is
 * implicitly transactional); on failure the transaction is rolled back.
 *
 * `mapError` lets the caller tag the failure (e.g. `LegacyDeclarativeApplyError`).
 */
export const legacyApplyMigrationFile = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationPath: string,
  mapError: (message: string) => E,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const content = yield* fs.readFileString(migrationPath);
    const statements = legacySplitAndTrim(content);
    const filename = path.basename(migrationPath);
    const matches = MIGRATE_FILE_PATTERN.exec(filename);
    const version = matches?.[1] ?? "";
    const name = matches?.[2] ?? "";

    yield* createMigrationTable(session);
    yield* session.exec("RESET ALL");
    yield* session.exec("BEGIN");
    // Mirror Go's `MigrationFile.ExecBatch` error context (`pkg/migration/file.go:88-113`):
    // on a failed statement, append `At statement: <index>` and the statement text so the
    // error (and the debug bundle) point at the exact failing SQL. (Go also adds a caret /
    // pgErr.Detail / extension-type hint, which need the driver SQLSTATE the session does
    // not currently surface — the statement number + text is the always-present context.)
    const errMessage = (e: unknown): string =>
      typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
        ? e.message
        : String(e);
    const atStatement = (e: unknown, index: number, stat: string) =>
      new Error(`${errMessage(e)}\nAt statement: ${index}\n${stat}`);
    const body = Effect.gen(function* () {
      for (let i = 0; i < statements.length; i++) {
        const statement = statements[i] ?? "";
        yield* session
          .exec(statement)
          .pipe(Effect.mapError((cause) => atStatement(cause, i, statement)));
      }
      if (version.length > 0) {
        // Go defaults to the version-insert statement when all listed statements succeed.
        yield* session
          .query(INSERT_MIGRATION_VERSION, [version, name, statements])
          .pipe(
            Effect.mapError((cause) =>
              atStatement(cause, statements.length, INSERT_MIGRATION_VERSION),
            ),
          );
      }
      yield* session.exec("COMMIT");
    });
    yield* body.pipe(Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)));
  }).pipe(
    Effect.mapError((error) =>
      mapError(
        "message" in error && typeof error.message === "string" ? error.message : String(error),
      ),
    ),
  );
