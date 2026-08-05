import { Data, Effect, type FileSystem, type Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { legacyBold } from "./legacy-colors.ts";
import type { LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { legacyErrorMessage } from "./legacy-error-message.ts";
import {
  INSERT_MIGRATION_VERSION,
  MIGRATE_FILE_PATTERN,
  legacyCreateMigrationTable,
} from "./legacy-migration-history.ts";
import { legacySqlFilesGlob } from "./legacy-sql-files-glob.ts";
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
//
// Provenance (CLI-1989, parity ruling 2026-07-30): the intended reference for this
// behaviour is the Go fix proposed for supabase/cli#5139 in PR supabase/cli#5156
// (`isPipelineIncompatible` / `trimLeadingSQLComments` in `pkg/migration/file.go`).
// That PR was closed WITHOUT merging — its design was adopted directly into this TS
// apply instead in PR supabase/cli#5671 (squash-merged to develop as b48fad60; the
// #5156 closing comment cites the PR-branch commit 29d3fb0e) because the Go path was
// being retired for the migration commands. The pinned Go oracle (`apps/cli-go`) therefore
// predated the fix; it now carries the same port of the closed PR (applied alongside
// this note) so TS-vs-Go parity audits compare like for like.
//
// Known residual delta: JS `\s` matches `\v` (vertical tab), but Go RE2 `\s` is
// `[\t\n\f\r ]` and does not. PostgreSQL >= 14 treats `\v` as SQL whitespace, so a
// statement separated only by `\v` (e.g. `VACUUM\v(FULL)`) classifies as
// pipeline-incompatible here but not under the Go oracle. Not worth changing
// behaviour over — flagging so a future parity sweep doesn't rediscover it.
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

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Port of Go's `markError` (`pkg/migration/file.go:117-132`): renders a `^` caret
 * line under the error position of the failing statement. `pos` is the server's
 * 1-based error cursor (`pgErr.Position`); Go consumes it against **byte**
 * lengths (`len(line)` on a Go string counts UTF-8 bytes) and pads the caret with
 * `pos-1` space bytes, so multibyte statements shift the caret exactly as Go does
 * (verified empirically against the Go implementation). The caret line REPLACES
 * every line after the error line (Go's `append(lines[:j+1], caret)` truncates
 * the tail). Position 0 (absent), a position past the end of the statement, or
 * one landing exactly on a line break leave the statement untouched.
 */
export const legacyMarkError = (stat: string, pos: number): string => {
  const lines = stat.split("\n");
  for (const [j, line] of lines.entries()) {
    const c = utf8ByteLength(line);
    if (pos > c) {
      pos -= c + 1;
      continue;
    }
    // Show a caret below the error position
    if (pos > 0) {
      return [...lines.slice(0, j + 1), `${" ".repeat(pos - 1)}^`].join("\n");
    }
    break;
  }
  return stat;
};

// Go's `typeNamePattern` (`pkg/migration/file.go:31`): extracts the type name from
// PostgreSQL error messages like `type "ltree" does not exist`. Unanchored, so it
// matches identically inside the rendered `ERROR: … (SQLSTATE …)` head line.
const TYPE_NAME_PATTERN = /type "([^"]+)" does not exist/;

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
  mapError: (message: string, phase: "read" | "exec") => E,
  forceNoVersion: boolean,
  displayPath: string = migrationPath,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    // Go's `MigrationFile.ExecBatch` receives an already-read/parsed file (the read
    // happens earlier, in `NewMigrationFromFile`/`parseFile`, which wraps the open
    // failure as `"failed to open migration file: %w"`, `pkg/migration/file.go:57-58`)
    // — so a read failure here is a DIFFERENT error class than a statement-execution
    // failure below, and needs the same Go prefix so stderr/JSON errors don't surface
    // the bare platform error text. Tagged "read" so callers that attach a suggestion
    // only around execution failures (`apply.go:61-63`) can tell the two apart.
    //
    // Go opens `fp` — the workdir-RELATIVE form `[db.migrations].schema_paths`/
    // `[db.seed].sql_paths` already resolved to at config-load time — because Go's
    // process cwd is always the workdir (`ChangeWorkDir`, `cmd/root.go:104`). This
    // module deliberately never `process.chdir`s (only `bootstrap` does, as its own
    // documented one-off), so callers must pass an ABSOLUTE `migrationPath` for the
    // real read to work — but that means the platform error's embedded path is
    // absolute too. When it differs from `displayPath` (the caller's Go-equivalent
    // relative path), substitute it in so the wrapped message still reports the
    // relative form Go would, not a leaked local temp/absolute path.
    const content = yield* fs.readFileString(migrationPath).pipe(
      Effect.mapError((error) => {
        const rawMessage = legacyErrorMessage(error);
        const message =
          displayPath === migrationPath
            ? rawMessage
            : rawMessage.split(migrationPath).join(displayPath);
        return mapError(`failed to open migration file: ${message}`, "read");
      }),
    );

    // Everything below mirrors Go's `(*MigrationFile).ExecBatch` (`pkg/migration/file.go`),
    // which runs against an already-read file — so every failure from here on is an
    // execution failure, tagged "exec" (as opposed to the "read" failure above, which
    // mirrors `NewMigrationFromFile`). Only execution failures get `CmdSuggestion`
    // (`apply.go:61-63`); callers rely on this tag to replicate that split.
    yield* Effect.gen(function* () {
      const statements = legacySplitAndTrim(content);
      const filename = path.basename(migrationPath);
      const matches = MIGRATE_FILE_PATTERN.exec(filename);
      const version = forceNoVersion ? "" : (matches?.[1] ?? "");
      const name = matches?.[2] ?? "";

      // Mirror Go's `MigrationFile.ExecBatch` error context (`pkg/migration/file.go:88-113`):
      // on a failed statement, render the `^` caret under the server-reported error
      // position, the `Detail` line when present, the SQLSTATE-42704 extension hint,
      // then `At statement: <index>` and the (caret-marked) statement text. The
      // structured `detail`/`position` fields are only set by the driver for server
      // ErrorResponses, mirroring Go's `errors.As(err, &pgErr)` gate.
      const atStatement = (e: LegacyDbExecError, index: number, stat: string) => {
        const marked = legacyMarkError(stat, e.position ?? 0);
        const msg: Array<string> = [];
        if (e.detail !== undefined && e.detail.length > 0) {
          msg.push(e.detail);
        }
        // Provide helpful hint for extension type errors (SQLSTATE 42704: undefined_object)
        const typeName = TYPE_NAME_PATTERN.exec(e.message)?.[1];
        if (typeName !== undefined && e.code === "42704" && !typeName.includes(".")) {
          msg.push("");
          msg.push("Hint: This type may be defined in a schema that's not in your search_path.");
          msg.push("      Use schema-qualified type references to avoid this error:");
          msg.push(`        CREATE TABLE example (col extensions.${typeName});`);
          msg.push("      Learn more: supabase migration new --help");
        }
        msg.push(`At statement: ${index}`, marked);
        return new Error(`${legacyErrorMessage(e)}\n${msg.join("\n")}`);
      };

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
    }).pipe(Effect.mapError((error) => mapError(legacyErrorMessage(error), "exec")));
  });

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
  session.exec("RESET ALL").pipe(Effect.mapError((e) => mapError(legacyErrorMessage(e))));

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
      Effect.mapError((e) => mapError(legacyErrorMessage(e))),
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
      Effect.mapError((e) => mapError(legacyErrorMessage(e))),
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

/**
 * Runs one SQL file's statements transactionally, WITHOUT `legacySeedGlobals`'s
 * per-file `Seeding globals from <name>...` stderr message, WITHOUT inserting a
 * migration history row, WITHOUT creating the history table, and WITHOUT `RESET
 * ALL` (same batching semantics as `legacySeedGlobals`, `forceNoVersion: true`,
 * just silent). Go's `initSchema`/`InitSchema14`/`ApplyApiPrivileges`
 * (`apps/cli-go/internal/db/start/start.go`) each call
 * `(*MigrationFile).ExecBatch` DIRECTLY on an in-memory SQL constant — bypassing
 * `migration.SeedGlobals`'s message — so reusing `legacySeedGlobals` for those
 * would print an extra line Go never prints. Callers write the in-memory SQL
 * constant to a temp file first (this module only reads files, like
 * `execMigrationBatch`'s other callers).
 *
 * `displayPath`, when given, is the path a read-failure's wrapped message should
 * report instead of `filePath` — see `execMigrationBatch`'s comment on why the two
 * can differ (an absolute path is required for the real read, but Go's equivalent
 * error names the workdir-relative form).
 */
export const legacyExecSqlFile = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  filePath: string,
  mapError: (message: string, phase: "read" | "exec") => E,
  displayPath?: string,
): Effect.Effect<void, E> =>
  execMigrationBatch(session, fs, path, filePath, mapError, true, displayPath);

/**
 * Applies Go's EXPERIMENTAL declarative schema-files branch of `apply.MigrateAndSeed`
 * (`apps/cli-go/internal/migration/apply/apply.go:19,51-68`). Reads `[db.migrations]
 * schema_paths` (already resolved to Go's config-load form — supabase-joined when
 * relative, verbatim when absolute) via the shared `Glob.SQLFiles` port
 * ({@link legacySqlFilesGlob}), then runs each matched file's statements with
 * {@link legacyExecSqlFile} in glob order — no history table, no history row, and no
 * `RESET ALL` between files, matching Go's `schema.Version = ""` discard (`apply.go:61`)
 * and the fact that `ExecBatch` (unlike `ApplyMigrations`) never resets connection state.
 *
 * Callers gate the call on Go's three-conjunct condition (`--experimental` + no resolved
 * version + pg-delta NOT enabled, `apply.go:19`) themselves — this function only performs
 * the branch's body, mirroring `applySchemaFiles`'s own signature (it never re-checks the
 * gate). It is the caller's responsibility to skip `legacyApplyMigrations` entirely when
 * this is called (Go's `if`/`else if` is mutually exclusive, `apply.go:19-27`).
 *
 * Faithfully reproduces two undocumented, unfixed-upstream Go quirks that are load-bearing
 * for the strict 1:1 contract (CLI-1958):
 *  - **Empty `schema_paths` (the `supabase init` default) silently applies nothing** and
 *    returns success — `Config.Db.Migrations.SchemaPaths.SQLFiles` returns a `nil` error
 *    when there are zero patterns to glob (`errors.Join()` with no arguments is `nil`), so
 *    `applySchemaFiles` returns `nil` too (`apply.go:53-54`).
 *  - **A PARTIAL glob failure is silently dropped**: per-pattern warnings are only
 *    surfaced (as the returned failure) when NO pattern matched anything at all
 *    (`declared` empty, `apply.go:53-55`); once at least one file is found, every other
 *    pattern's warning is discarded — unlike the seed path's `WARN:` line.
 *
 * On a per-file EXECUTION failure only, attaches Go's `CmdSuggestion = "See schema file:
 * <Bold(fp)>"` (`apply.go:63`) via the optional second argument of `mapError`. A file-READ
 * failure (Go's `NewMigrationFromFile`, `apply.go:57-59`) returns before `CmdSuggestion` is
 * ever set, so it must NOT carry the suggestion — {@link legacyExecSqlFile}'s `mapError`
 * receives the `"read"`/`"exec"` phase precisely so this call site can tell them apart.
 */
export const legacyApplySchemaFiles = <E>(
  session: LegacyDbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  schemaPaths: ReadonlyArray<string>,
  mapError: (message: string, suggestion?: string) => E,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const { files, warnings } = yield* legacySqlFilesGlob(fs, path, schemaPaths, workdir);
    if (files.length === 0) {
      // Go: `if len(declared) == 0 { return err }` — `err` is `nil` when there were no
      // patterns to glob at all, and the joined per-pattern warnings otherwise.
      if (warnings.length > 0) {
        return yield* Effect.fail(mapError(warnings.join("\n")));
      }
      return;
    }
    for (const file of files) {
      const absolutePath = path.isAbsolute(file) ? file : path.join(workdir, file);
      // `file` is already Go's `fp` form (workdir-relative when the declared pattern
      // was relative, verbatim when absolute) — pass it through as the display path so
      // a read failure reports it instead of the `absolutePath` the real read needs.
      yield* legacyExecSqlFile(
        session,
        fs,
        path,
        absolutePath,
        (message, phase) =>
          phase === "exec"
            ? mapError(message, `See schema file: ${legacyBold(file)}`)
            : mapError(message),
        file,
      );
    }
  });
