import { Data, Effect, type FileSystem, type Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import {
  INSERT_MIGRATION_VERSION,
  MIGRATE_FILE_PATTERN,
  legacyCreateMigrationTable,
} from "./legacy-migration-history.ts";
import { legacySplitAndTrim } from "./legacy-sql-split.ts";

/**
 * Applying a migration file failed (Go's `ApplyMigrations` / `ExecBatch` error).
 * Used by `migration up` and `migration down`'s migrate-and-seed step. The
 * declarative sync handler maps its own error type instead.
 */
export class LegacyMigrationApplyError extends Data.TaggedError("LegacyMigrationApplyError")<{
  readonly message: string;
}> {}

// Byte order mark (U+FEFF) — stripped from the head of a statement like Go does.
const BOM_CODE_POINT = 0xfeff;

// Statements that PostgreSQL refuses to run inside a transaction block / extended-query
// pipeline (SQLSTATE 25001). Ports of Go's pattern set in `pkg/migration/file.go`
// (supabase/cli#5156). Matched against the upper-cased, comment-stripped statement.
const CREATE_INDEX_CONCURRENTLY_PATTERN = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY(?:\s|$)/u;
const REINDEX_CONCURRENTLY_PATTERN = /^REINDEX(?:\s|\().*\sCONCURRENTLY(?:\s|$)/u;
const VACUUM_PATTERN = /^VACUUM(?:\s|\(|$)/u;
const ALTER_SYSTEM_PATTERN = /^ALTER\s+SYSTEM(?:\s|$)/u;
const CLUSTER_PATTERN = /^CLUSTER(?:\s|$)/u;

/**
 * Strips a leading BOM, whitespace, and SQL line (`--`) and block comments from the
 * front of a statement so the keyword check below sees the real first token.
 * Port of Go's `trimLeadingSQLComments` (`pkg/migration/file.go`, supabase/cli#5156).
 */
const legacyTrimLeadingSqlComments = (sql: string): string => {
  // Go's `TrimLeftFunc` drops a leading BOM together with whitespace; strip the BOM
  // via its code point so no irregular whitespace lands in the source.
  let trimmed = sql.replace(/^[ \t\n\r]+/u, "");
  while (trimmed.charCodeAt(0) === BOM_CODE_POINT) {
    trimmed = trimmed.slice(1).replace(/^[ \t\n\r]+/u, "");
  }
  for (;;) {
    if (trimmed.startsWith("--")) {
      const idx = trimmed.indexOf("\n");
      if (idx < 0) return "";
      trimmed = trimmed.slice(idx + 1).replace(/^[ \t\n\r]+/u, "");
    } else if (trimmed.startsWith("/*")) {
      const idx = trimmed.indexOf("*/");
      if (idx < 0) return trimmed;
      trimmed = trimmed.slice(idx + 2).replace(/^[ \t\n\r]+/u, "");
    } else {
      return trimmed.trim();
    }
  }
};

/**
 * Whether a migration statement cannot run inside a transaction block — `CREATE
 * [UNIQUE] INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`,
 * `CLUSTER`. Such statements fail with SQLSTATE 25001 inside the `BEGIN`/`COMMIT`
 * that wraps a migration, so `execMigrationBatch` runs them standalone.
 * Port of Go's `isPipelineIncompatible` (`pkg/migration/file.go`, supabase/cli#5156).
 */
export const legacyIsPipelineIncompatible = (sql: string): boolean => {
  const upper = legacyTrimLeadingSqlComments(sql).toUpperCase();
  return (
    CREATE_INDEX_CONCURRENTLY_PATTERN.test(upper) ||
    REINDEX_CONCURRENTLY_PATTERN.test(upper) ||
    VACUUM_PATTERN.test(upper) ||
    ALTER_SYSTEM_PATTERN.test(upper) ||
    CLUSTER_PATTERN.test(upper)
  );
};

/** A buffered statement awaiting the next batch flush; `version` is the history insert. */
type LegacyBatchItem =
  | { readonly kind: "exec"; readonly sql: string }
  | { readonly kind: "version" };

const errMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/**
 * Runs a single migration/seed file's statements (plus the optional history insert).
 * Mirrors Go's `(*MigrationFile).ExecBatch` (`pkg/migration/file.go`): statements run
 * inside a `BEGIN`/`COMMIT` batch, except pipeline-incompatible ones
 * (`legacyIsPipelineIncompatible` — `CREATE INDEX CONCURRENTLY`, `VACUUM`, …) which
 * cannot run in a transaction block: the open batch is flushed (committed), the
 * statement runs standalone, then batching resumes (supabase/cli#5156). The history
 * insert goes in the final batch, so the migration is recorded only after every
 * statement succeeds. A file with no such statements is a single `BEGIN`/`COMMIT`.
 *
 * Does NOT create the history table and does NOT `RESET ALL` — Go's `ExecBatch` does
 * neither; those are the migration-apply path's responsibility (`ApplyMigrations`,
 * apply.go:65-69), so role/globals files (`legacySeedGlobals`) stay reset-free like Go.
 * When `forceNoVersion` is set the history insert is skipped regardless of filename
 * (Go's `SeedGlobals` clears `Version`).
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

    // Mirror Go's `MigrationFile.ExecBatch` error context (`pkg/migration/file.go`):
    // on a failed statement, append `At statement: <index>` and the statement text.
    const atStatement = (e: unknown, index: number, stat: string) =>
      new Error(`${errMessage(e)}\nAt statement: ${index}\n${stat}`);

    // `executed` is the global statement index of the next statement to run, so the
    // error context stays accurate across flushed batches and standalone statements
    // (Go threads the same counter through `ExecBatch`).
    let pending: ReadonlyArray<LegacyBatchItem> = [];
    let executed = 0;

    const flushBatch = Effect.gen(function* () {
      if (pending.length === 0) return;
      const items = pending;
      pending = [];
      const base = executed;
      const body = Effect.gen(function* () {
        for (const [offset, item] of items.entries()) {
          const index = base + offset;
          if (item.kind === "version") {
            // Go defaults to the version-insert statement when all listed statements succeed.
            yield* session
              .query(INSERT_MIGRATION_VERSION, [version, name, statements])
              .pipe(
                Effect.mapError((cause) => atStatement(cause, index, INSERT_MIGRATION_VERSION)),
              );
          } else {
            yield* session
              .exec(item.sql)
              .pipe(Effect.mapError((cause) => atStatement(cause, index, item.sql)));
          }
        }
        yield* session.exec("COMMIT");
      });
      yield* session.exec("BEGIN");
      yield* body.pipe(Effect.tapError(() => session.exec("ROLLBACK").pipe(Effect.ignore)));
      executed += items.length;
    });

    for (const statement of statements) {
      if (legacyIsPipelineIncompatible(statement)) {
        // Flush the open batch, then run the incompatible statement on its own (no
        // surrounding transaction) so PostgreSQL accepts it.
        yield* flushBatch;
        const index = executed;
        yield* session
          .exec(statement)
          .pipe(Effect.mapError((cause) => atStatement(cause, index, statement)));
        executed += 1;
      } else {
        pending = [...pending, { kind: "exec", sql: statement }];
      }
    }
    if (version.length > 0) {
      pending = [...pending, { kind: "version" }];
    }
    yield* flushBatch;
  }).pipe(Effect.mapError((error) => mapError(errMessage(error))));

/**
 * Go's per-migration connection reset (`apply.go:65-69`): `RESET ALL` clears any
 * connection settings a prior statement on the same session may have changed
 * (e.g. `set_config('search_path', …)`), run before each migration's `ExecBatch`.
 * Only the migration-apply path does this — `SeedGlobals` (role/globals files)
 * must NOT, so this is a caller responsibility, never inside `execMigrationBatch`.
 */
const resetConnectionState = <E>(
  session: LegacyDbSession,
  mapError: (message: string) => E,
): Effect.Effect<void, E> =>
  session.exec("RESET ALL").pipe(Effect.mapError((e) => mapError(errMessage(e))));

/**
 * Applies a single migration file to the connected database and records it in
 * `supabase_migrations.schema_migrations`. Mirrors Go's `migration.ApplyMigrations`
 * for one file (`pkg/migration/apply.go` + `(*MigrationFile).ExecBatch`): `RESET ALL`
 * first to clear any session state leaked by a prior file (e.g.
 * `SET default_transaction_read_only = on`) before the history-table DDL, then create
 * the history table, then run the file's statements + the history insert.
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
    yield* resetConnectionState(session, mapError);
    yield* legacyCreateMigrationTable(session).pipe(
      Effect.mapError((e) => mapError(errMessage(e))),
    );
    yield* execMigrationBatch(session, fs, path, migrationPath, mapError, false);
  });

/**
 * Applies a list of pending migration files, mirroring Go's
 * `migration.ApplyMigrations` (`pkg/migration/apply.go:56-77`): create the
 * history table once when there is anything to apply, then for each file emit
 * `Applying migration <name>...` to stderr, `RESET ALL`, and run it transactionally.
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
      // Go resets connection state per migration (apply.go:65-69) before ExecBatch.
      yield* resetConnectionState(session, mapError);
      yield* execMigrationBatch(session, fs, path, migrationPath, mapError, false);
    }
  });

/**
 * Applies custom-role / globals files, mirroring Go's `migration.SeedGlobals`
 * (`pkg/migration/seed.go:85-100`): for each file emit `Seeding globals from
 * <name>...` to stderr and run it transactionally WITHOUT inserting a migration
 * history row (Go clears `Version`), WITHOUT creating the history table, and WITHOUT
 * `RESET ALL` (Go's `SeedGlobals` → `ExecBatch` never resets).
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
