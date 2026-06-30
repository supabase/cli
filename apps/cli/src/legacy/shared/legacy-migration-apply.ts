import { Data, Effect, type FileSystem, type Path } from "effect";

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
 * that wraps a migration, so `legacyApplyMigrationFile` runs them standalone.
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

/**
 * Applies a single migration file to the connected database and records it in
 * `supabase_migrations.schema_migrations`. Mirrors Go's `migration.ApplyMigrations`
 * for one file (`pkg/migration/apply.go` + `(*MigrationFile).ExecBatch`): `RESET ALL`
 * first to clear any session state leaked by a prior file, then create the history
 * table, then run the file's statements + the history insert.
 *
 * Statements run inside a `BEGIN`/`COMMIT` batch, except pipeline-incompatible ones
 * (`legacyIsPipelineIncompatible` — `CREATE INDEX CONCURRENTLY`, `VACUUM`, …) which
 * cannot run in a transaction block: the batch is flushed (committed), the statement
 * runs standalone, then batching resumes — mirroring Go's `ExecBatch` flush logic
 * (supabase/cli#5156). The history insert goes in the final batch, so the migration
 * is recorded only after every statement succeeds. A file with no such statements is
 * a single `BEGIN`/`COMMIT` around everything, identical to the pre-fix behaviour.
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

    // `RESET ALL` runs FIRST, before the history-table DDL: an earlier migration applied
    // on this same connection may have left a session default (e.g.
    // `SET default_transaction_read_only = on`) that would otherwise make this DDL fail
    // before it is cleared. Go resets connection state at the top of each file's apply,
    // ahead of any work (`apps/cli-go/pkg/migration/apply.go:65-69`).
    yield* session.exec("RESET ALL");
    yield* legacyCreateMigrationTable(session);

    // Mirror Go's `MigrationFile.ExecBatch` error context (`pkg/migration/file.go`):
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
  }).pipe(
    Effect.mapError((error) =>
      mapError(
        "message" in error && typeof error.message === "string" ? error.message : String(error),
      ),
    ),
  );
