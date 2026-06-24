import { Effect, type FileSystem, type Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
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
const legacyCreateMigrationTable = (session: LegacyDbSession) =>
  Effect.gen(function* () {
    yield* session.exec(SET_LOCK_TIMEOUT);
    yield* session.exec(CREATE_VERSION_SCHEMA);
    yield* session.exec(CREATE_VERSION_TABLE);
    yield* session.exec(ADD_STATEMENTS_COLUMN);
    yield* session.exec(ADD_NAME_COLUMN);
  });

const errMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/**
 * Runs a single migration/seed file's statements (plus the optional history
 * insert) inside one transaction. Mirrors Go's `(*MigrationFile).ExecBatch`
 * (`pkg/migration/file.go:75-115`) — the batch is implicitly transactional, so a
 * failed statement rolls the file back. Does NOT create the history table; the
 * caller decides whether to (Go's `ApplyMigrations` creates it once up front,
 * `SeedGlobals` never does). When `forceNoVersion` is set the history insert is
 * skipped regardless of filename (Go's `SeedGlobals` clears `Version`).
 */
const execMigrationBatch = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationPath: string,
  mapError: (message: string) => E,
  forceNoVersion: boolean,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const content = yield* fs.readFileString(migrationPath);
    const statements = legacySplitAndTrim(content);
    const filename = path.basename(migrationPath);
    const matches = MIGRATE_FILE_PATTERN.exec(filename);
    const version = forceNoVersion ? "" : (matches?.[1] ?? "");
    const name = matches?.[2] ?? "";

    yield* session.exec("RESET ALL");
    yield* session.exec("BEGIN");
    // Mirror Go's `MigrationFile.ExecBatch` error context (`pkg/migration/file.go:88-113`):
    // on a failed statement, append `At statement: <index>` and the statement text.
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
  }).pipe(Effect.mapError((error) => mapError(errMessage(error))));

/**
 * Applies a single migration file to the connected database and records it in
 * `supabase_migrations.schema_migrations`. Mirrors Go's `migration.ApplyMigrations`
 * for one file (`pkg/migration/apply.go` + `(*MigrationFile).ExecBatch`): create
 * the history table, `RESET ALL`, then run the file's statements + the history
 * insert atomically.
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
    yield* legacyCreateMigrationTable(session).pipe(
      Effect.mapError((e) => mapError(errMessage(e))),
    );
    yield* execMigrationBatch(session, fs, path, migrationPath, mapError, false);
  });

/**
 * Applies a list of pending migration files, mirroring Go's
 * `migration.ApplyMigrations` (`pkg/migration/apply.go:56-77`): create the
 * history table once when there is anything to apply, then for each file emit
 * `Applying migration <name>...` to stderr and run it transactionally.
 */
export const legacyApplyMigrations = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  pending: ReadonlyArray<string>,
  mapError: (message: string) => E,
): Effect.Effect<void, E, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (pending.length === 0) return;
    yield* legacyCreateMigrationTable(session).pipe(
      Effect.mapError((e) => mapError(errMessage(e))),
    );
    for (const migrationPath of pending) {
      yield* output.raw(`Applying migration ${path.basename(migrationPath)}...\n`, "stderr");
      yield* execMigrationBatch(session, fs, path, migrationPath, mapError, false);
    }
  });

/**
 * Applies custom-role / globals files, mirroring Go's `migration.SeedGlobals`
 * (`pkg/migration/seed.go:85-100`): for each file emit `Seeding globals from
 * <name>...` to stderr and run it transactionally WITHOUT inserting a migration
 * history row (Go clears `Version`) and WITHOUT creating the history table.
 */
export const legacySeedGlobals = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  globals: ReadonlyArray<string>,
  mapError: (message: string) => E,
): Effect.Effect<void, E, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    for (const globalPath of globals) {
      yield* output.raw(`Seeding globals from ${path.basename(globalPath)}...\n`, "stderr");
      yield* execMigrationBatch(session, fs, path, globalPath, mapError, true);
    }
  });
