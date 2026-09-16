import { Data, Effect, type FileSystem, type Path } from "effect";

import { Output } from "../shared/output/output.service.ts";
import { bold } from "./colors.ts";
import { DbConnectError, DbExecError } from "./db-connection.errors.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import type { DbBatchStatement, DbSession } from "./db-connection.service.ts";
import { errorMessage, relativizeErrorMessage } from "./error-message.ts";
import {
  INSERT_MIGRATION_VERSION,
  MIGRATE_FILE_PATTERN,
  createMigrationTable,
  sortMigrationPathsByVersion,
} from "./migration-history.ts";
import { parseMigrationContent } from "./migration-file.ts";
import { sqlFilesGlob } from "./sql-files-glob.ts";
import { splitSqlTokens } from "./sql-split.ts";

/**
 * A migration file failed to apply. Used by `migration up`/`down`'s migrate-and-seed step; the
 * declarative sync handler maps its own error type instead.
 *
 * `suggestion` carries caller remediation: schema-file guidance from `applySchemaFiles`, or
 * local-only pg_net/webhooks remediation when start/reset replay can identify that failure.
 */
export class MigrationApplyError extends Data.TaggedError("MigrationApplyError")<{
  readonly message: string;
  readonly suggestion?: string;
  readonly reason?: "local_pg_net_unavailable";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.reason === "local_pg_net_unavailable"
      ? actionability.invalidConfig
      : actionability.dbFinding;
  }
}

// Byte order mark (U+FEFF), stripped from the head of a statement.
const BOM_CODE_POINT = 0xfeff;

// Statements that PostgreSQL refuses to run inside a transaction block / extended-query
// pipeline (SQLSTATE 25001). Matched against the upper-cased, comment-stripped statement.
//
// JS's `\s` also matches `\v` (vertical tab), which PostgreSQL >= 14 treats as SQL whitespace —
// so a statement separated only by `\v` (e.g. `VACUUM\v(FULL)`) classifies as
// pipeline-incompatible here, a known, unfixed edge case.
const CREATE_INDEX_CONCURRENTLY_PATTERN = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY(?:\s|$)/u;
const DROP_INDEX_CONCURRENTLY_PATTERN = /^DROP\s+INDEX\s+CONCURRENTLY(?:\s|$)/u;
const REINDEX_CONCURRENTLY_PATTERN = /^REINDEX(?:\s|\().*\sCONCURRENTLY(?:\s|$)/u;
const VACUUM_PATTERN = /^VACUUM(?:\s|\(|$)/u;
const ALTER_SYSTEM_PATTERN = /^ALTER\s+SYSTEM(?:\s|$)/u;
const CLUSTER_PATTERN = /^CLUSTER(?:\s|$)/u;
const TRANSACTION_CONTROL_PATTERN =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|PREPARE\s+TRANSACTION)(?:\s|$)/u;

/**
 * Strips a leading BOM, whitespace, and SQL line (`--`) and block comments from the
 * front of a statement so the keyword check below sees the real first token.
 */
const trimLeadingSqlComments = (sql: string): string => {
  // Stripped via code point comparison so it isn't relied on to match a whitespace regex class.
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
 * Whether a migration statement cannot run inside a transaction block — `CREATE [UNIQUE] INDEX
 * CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`,
 * `CLUSTER`. These fail with SQLSTATE 25001 inside the implicit transaction a migration batch
 * creates, so `execMigrationBatch` runs them standalone.
 */
export const isPipelineIncompatible = (sql: string): boolean => {
  const upper = trimLeadingSqlComments(sql).toUpperCase();
  return (
    CREATE_INDEX_CONCURRENTLY_PATTERN.test(upper) ||
    DROP_INDEX_CONCURRENTLY_PATTERN.test(upper) ||
    REINDEX_CONCURRENTLY_PATTERN.test(upper) ||
    VACUUM_PATTERN.test(upper) ||
    ALTER_SYSTEM_PATTERN.test(upper) ||
    CLUSTER_PATTERN.test(upper)
  );
};

/** Whether the statement owns a transaction boundary that must not be nested. */
export const hasTransactionControl = (sql: string): boolean => {
  const upper = trimLeadingSqlComments(sql).toUpperCase();
  const words = upper.split(/\s+/u);
  if (words[0] === "ROLLBACK") {
    const toIndex = words[1] === "WORK" || words[1] === "TRANSACTION" ? 2 : 1;
    // ROLLBACK [WORK | TRANSACTION] TO [SAVEPOINT] rewinds the current
    // transaction without ending it, so it still needs the CLI-managed wrapper.
    return words[toIndex] !== "TO";
  }
  return TRANSACTION_CONTROL_PATTERN.test(upper);
};

const ROLE_REVERT_PATTERN =
  /^(?:RESET\s+ROLE|RESET\s+SESSION\s+AUTHORIZATION|SET\s+(?:SESSION\s+)?ROLE(?:\s+TO\s+|\s*=\s*|\s+)(?:NONE|DEFAULT)|SET\s+SESSION\s+AUTHORIZATION\s+DEFAULT|DISCARD\s+ALL)(?:\s|;|$)/u;

// PostgreSQL's `check_role` compares the quoted value case-sensitively against
// "none", so the quoted spellings are matched before the uppercase fold —
// `SET ROLE "NONE"` selects a real role named `NONE`, never a reset.
const QUOTED_ROLE_VALUE_PATTERN =
  /^SET\s+(?:SESSION\s+)?ROLE(?:\s+TO\s+|\s*=\s*|\s+)(['"])(.*?)\1(?:\s|;|$)/iu;

/**
 * Whether a top-level statement reverts a stepped-down session to its login role (`RESET ROLE`,
 * `SET`-based role resets, `RESET SESSION AUTHORIZATION`, `DISCARD ALL`). File runners re-assert
 * `postgres` right after each match; reverts a lexical check can't see (dynamic SQL, `SET LOCAL
 * ROLE NONE`, since a session-scoped restore would override its transaction scope) are
 * backstopped by the trailing restore before any CLI-owned write. `RESET ALL` is absent because
 * `role` carries `GUC_NO_RESET_ALL`.
 */
export const revertsToLoginRole = (sql: string): boolean => {
  const trimmed = trimLeadingSqlComments(sql);
  return (
    ROLE_REVERT_PATTERN.test(trimmed.toUpperCase()) ||
    QUOTED_ROLE_VALUE_PATTERN.exec(trimmed)?.[2] === "none"
  );
};

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

// The scanner buffer starts at this size before applying the configured/default max, so a
// statement must reach at least this many bytes before an oversized-token error can fire,
// regardless of how small an override is set.
const GO_SCANNER_START_BUF_SIZE = 4096;

// Fallback cap when `SUPABASE_SCANNER_BUFFER_SIZE` is set but parses to a non-positive size,
// including a value that can't be parsed at all (e.g. a bare "5M" with no trailing "B").
const GO_DEFAULT_MAX_SCANNER_CAPACITY = 256 * 1024;

const GO_MAX_INT64 = 9223372036854775807n;
const GO_MIN_INT64 = -9223372036854775808n;

/**
 * Parses a base-0 integer literal: decimal, or `0x`/`0o`/`0b`-prefixed hex/octal/binary, or a
 * bare leading-zero octal (e.g. `"0755"`), with `_` digit separators allowed between digits of
 * the same base (never leading, trailing, or doubled). Returns `undefined` for anything invalid
 * or outside the 64-bit signed integer range.
 */
const parseGoBaseZeroInt = (value: string): number | undefined => {
  const negative = value.startsWith("-");
  const unsigned = negative || value.startsWith("+") ? value.slice(1) : value;
  if (unsigned.length === 0) return undefined;

  let base = 10;
  let digits = unsigned;
  const prefix = unsigned.slice(0, 2).toLowerCase();
  if (prefix === "0x") {
    base = 16;
    digits = unsigned.slice(2);
  } else if (prefix === "0o") {
    base = 8;
    digits = unsigned.slice(2);
  } else if (prefix === "0b") {
    base = 2;
    digits = unsigned.slice(2);
  } else if (unsigned.length > 1 && unsigned[0] === "0") {
    // Legacy (no "o") leading-zero octal, e.g. "0755".
    base = 8;
    digits = unsigned.slice(1);
  }
  if (digits.length === 0) return undefined;

  // Only a real base prefix (or the legacy-octal leading "0") may be followed
  // immediately by an underscore; a plain decimal literal has no prefix to
  // follow, so a leading underscore there is always invalid.
  const hadPrefix = base !== 10;
  const digitClass = base === 16 ? "0-9a-fA-F" : base === 8 ? "0-7" : base === 2 ? "01" : "0-9";
  const validPattern = new RegExp(
    `^${hadPrefix ? "_?" : ""}[${digitClass}](?:_?[${digitClass}])*$`,
  );
  if (!validPattern.test(digits)) return undefined;

  const cleanDigits = digits.replace(/_/g, "");
  // Exact-magnitude range check via BigInt — `Number.parseInt` below loses precision
  // past 2^53 and never errors, so the int64 bound must be checked independently of it.
  const bigPrefix = base === 16 ? "0x" : base === 8 ? "0o" : base === 2 ? "0b" : "";
  const magnitude = BigInt(`${bigPrefix}${cleanDigits}`);
  const signedMagnitude = negative ? -magnitude : magnitude;
  if (signedMagnitude > GO_MAX_INT64 || signedMagnitude < GO_MIN_INT64) return undefined;

  const n = Number.parseInt(cleanDigits, base);
  return negative ? -n : n;
};

// Drops a decimal literal's fractional part rather than rounding (`"5.5"` → `"5"`); a
// `0x`/`0o`/`0b` literal (which contains letters) never matches and passes through unchanged for
// {@link parseGoBaseZeroInt} to accept or reject.
const trimGoDecimal = (value: string): string => {
  if (!value.includes(".")) return value;
  const match = /^([+-]?\d*)(?:\.\d*)?$/.exec(value);
  if (!match) return value;
  const intPart = match[1] ?? "";
  if (intPart === "+" || intPart === "-") return `${intPart}0`;
  return intPart === "" ? "0" : intPart;
};

/**
 * `SUPABASE_SCANNER_BUFFER_SIZE` accepts an integer byte count, optionally suffixed
 * `k`/`m`/`g` (× 1024/1024²/1024³) immediately followed by a trailing `b`/`B` (e.g. `"5MB"`). A
 * bare `"5M"` (no trailing `B`) is NOT 5 MiB — it fails to parse as an integer and is treated as
 * unset (`0`), same as any other unparseable or non-positive value. See {@link parseGoBaseZeroInt}
 * for the accepted integer-literal grammar (hex/octal/binary prefixes, `_` separators).
 */
const parseScannerBufferSize = (raw: string): number => {
  let value = raw.trim();
  let multiplier = 1;
  const lastIndex = value.length - 1;
  if (lastIndex > 1 && (value[lastIndex] === "b" || value[lastIndex] === "B")) {
    switch (value[lastIndex - 1]!.toLowerCase()) {
      case "k":
        multiplier = 1 << 10;
        value = value.slice(0, lastIndex - 1).trim();
        break;
      case "m":
        multiplier = 1 << 20;
        value = value.slice(0, lastIndex - 1).trim();
        break;
      case "g":
        multiplier = 1 << 30;
        value = value.slice(0, lastIndex - 1).trim();
        break;
      default:
        value = value.slice(0, lastIndex).trim();
        break;
    }
  }
  const size = parseGoBaseZeroInt(trimGoDecimal(value));
  return size !== undefined && Number.isFinite(size) && size > 0 ? size * multiplier : 0;
};

/**
 * Enforces `SUPABASE_SCANNER_BUFFER_SIZE` as the per-statement scan limit — a no-op unless the
 * env var is set — as the single home for this check shared by every `execMigrationBatch` caller.
 *
 * Fails on the first raw (pre-trim) statement exceeding the effective limit, reporting the count
 * and raw text of the last statement scanned before it; this is a "read"-phase failure, so it
 * carries no suggestion. `projectEnv`, when given, is the caller's already-loaded project-env map,
 * so a `supabase/.env`-only override is honored here too.
 */
export const checkScannerBufferSize = <E>(
  content: string,
  mapError: (message: string, phase: "read" | "exec") => E,
  projectEnv: Readonly<Record<string, string>> = {},
): Effect.Effect<void, E> => {
  const raw =
    process.env["SUPABASE_SCANNER_BUFFER_SIZE"] ?? projectEnv["SUPABASE_SCANNER_BUFFER_SIZE"];
  if (raw === undefined) return Effect.void;
  const configuredLimit = parseScannerBufferSize(raw);
  // Covers both an explicit non-positive size and an unparseable value (see
  // `GO_DEFAULT_MAX_SCANNER_CAPACITY` above) — both fall back to the hardcoded default cap, not
  // to "no limit".
  const limit =
    configuredLimit > 0
      ? Math.max(configuredLimit, GO_SCANNER_START_BUF_SIZE)
      : GO_DEFAULT_MAX_SCANNER_CAPACITY;
  // The reported limit is the raw configured value, even below the `GO_SCANNER_START_BUF_SIZE`
  // floor (which only affects when the too-long error can fire, not the number reported), or the
  // hardcoded default once that's been fallen back to.
  const reportedLimit = configuredLimit > 0 ? configuredLimit : GO_DEFAULT_MAX_SCANNER_CAPACITY;
  let emitted = 0;
  let lastRaw = "";
  for (const token of splitSqlTokens(content)) {
    // A terminated token exactly at `limit` still succeeds (only strictly-over fails, `>`); an
    // unterminated trailing token at `limit` already fails (`>=`), since there's no delimiter left
    // to find once the buffer fills without one.
    const tooLong = token.terminated
      ? utf8ByteLength(token.raw) > limit
      : utf8ByteLength(token.raw) >= limit;
    if (tooLong) {
      const suggestion = `Try setting SUPABASE_SCANNER_BUFFER_SIZE=5MB (current size is ${Math.floor(reportedLimit / 1024)}KB)`;
      return Effect.fail(
        mapError(
          `bufio.Scanner: token too long\nAfter statement ${emitted}: ${lastRaw}\n${suggestion}`,
          "read",
        ),
      );
    }
    // `lastRaw` updates on every scanned token, even ones that trim to empty and don't advance
    // `emitted` — so a lone `;` right before an oversized statement reports it accurately instead
    // of a blank token.
    lastRaw = token.raw;
    if (token.trimmed.length > 0) {
      emitted += 1;
    }
  }
  return Effect.void;
};

/**
 * Renders a `^` caret line under the error position of a failing statement. `pos` is the
 * server's 1-based error cursor, measured in UTF-8 bytes, so multibyte statements shift the caret
 * correctly. The caret line replaces every line after the error line. Position 0 (absent), a
 * position past the end of the statement, or one landing exactly on a line break leave the
 * statement untouched.
 */
export const markError = (stat: string, pos: number): string => {
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

// Extracts the type name from PostgreSQL error messages like `type "ltree" does not exist`.
// Unanchored, so it also matches inside the rendered `ERROR: … (SQLSTATE …)` head line.
const TYPE_NAME_PATTERN = /type "([^"]+)" does not exist/;

/**
 * Renders a failed statement's error context: the `^` caret under the server-reported error
 * position, the `Detail` line when present, the SQLSTATE-42704 extension hint, then
 * `At statement: <index>` and the caret-marked statement text. The structured `detail`/`position`
 * fields are only set by the driver for real server error responses.
 *
 * Exported so any caller that runs a raw batch-equivalent statement set outside a migration file
 * (e.g. `resetRecreateDatabases`'s PG14 `DROP`/`CREATE DATABASE` statements) gets the same rich
 * error context instead of the bare driver error.
 */
export const formatExecBatchError = (e: DbExecError, index: number, stat: string): Error => {
  const marked = markError(stat, e.position ?? 0);
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
  return formattedExecBatchFailure(`${errorMessage(e)}\n${msg.join("\n")}`, e);
};

/** Retains the server error after adding statement context to the message. */
const FormattedExecBatchDbErrorId: unique symbol = Symbol("FormattedExecBatchDbError");
type FormattedExecBatchFailure = Error & {
  readonly [FormattedExecBatchDbErrorId]: DbExecError;
};
const formattedExecBatchFailure = (
  message: string,
  dbError: DbExecError,
): FormattedExecBatchFailure =>
  Object.assign(new Error(message), { [FormattedExecBatchDbErrorId]: dbError });

const formattedExecBatchDbError = (error: unknown): DbExecError | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const dbError: unknown = Reflect.get(error, FormattedExecBatchDbErrorId);
  return dbError instanceof DbExecError ? dbError : undefined;
};

/**
 * Runs a single migration/seed file's statements, plus the optional history insert.
 *
 * Statements batch inside an implicit transaction, except pipeline-incompatible ones
 * ({@link isPipelineIncompatible}), which flush the batch, run standalone, then resume it. The
 * history insert is part of the final batch, so it's recorded only once every statement
 * succeeds. On a stepped-down session, the `postgres` role is re-asserted after each top-level
 * role-reverting statement ({@link revertsToLoginRole}) and again before the history insert —
 * applies to every file runner, including `seedGlobals`, and never shifts `At statement: N`.
 *
 * A file starting `-- pg-delta: transaction=false` instead runs every statement sequentially on
 * one connection, with a best-effort session reset on failure.
 *
 * Does not create the history table or unconditionally `RESET ALL` (caller responsibility).
 * `forceNoVersion` skips the history insert; `projectEnv` is forwarded to
 * {@link checkScannerBufferSize}.
 */
const execMigrationBatch = <E>(
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationPath: string,
  mapError: (message: string, phase: "read" | "exec", dbError?: DbExecError) => E,
  forceNoVersion: boolean,
  displayPath: string = migrationPath,
  projectEnv: Readonly<Record<string, string>> = {},
): Effect.Effect<void, E | DbConnectError> =>
  Effect.gen(function* () {
    // A read failure here is a different error class than a statement-execution failure below,
    // tagged "read" so callers that attach a suggestion only around execution failures can tell
    // the two apart.
    //
    // This module never `process.chdir`s, so callers must pass an absolute `migrationPath` — but
    // that means the platform error's embedded path is absolute too. When it differs from
    // `displayPath` (the caller's relative path), substitute it in so the wrapped message reports
    // the relative form instead.
    //
    // Known limitation: invalid UTF-8 bytes in the file are lossily replaced with U+FFFD before
    // reaching `session.exec`, since the underlying `pg` wire protocol always re-encodes query
    // text as UTF-8 regardless of how the bytes are read here.
    const content = yield* fs.readFileString(migrationPath).pipe(
      Effect.mapError((error) => {
        const message = relativizeErrorMessage(errorMessage(error), migrationPath, displayPath);
        return mapError(`failed to open migration file: ${message}`, "read");
      }),
    );

    // A scanner-buffer violation is a "read"-phase failure like the open failure above, not
    // "exec" — this call is a no-op unless the env var is explicitly set.
    yield* checkScannerBufferSize(content, mapError, projectEnv);

    // Every failure from here on is an execution failure, tagged "exec" (vs. the "read" failures
    // above) — only execution failures get a suggestion attached; callers rely on this tag.
    yield* Effect.gen(function* () {
      const { statements, transactionMode } = parseMigrationContent(content);
      const filename = path.basename(migrationPath);
      const matches = MIGRATE_FILE_PATTERN.exec(filename);
      const version = forceNoVersion ? "" : (matches?.[1] ?? "");
      const name = matches?.[2] ?? "";

      const restoreRole = session.restoreRoleSql;

      const executeSequentially = (cleanup: string) =>
        Effect.gen(function* () {
          for (const [index, statement] of statements.entries()) {
            yield* session
              .exec(statement)
              .pipe(Effect.mapError((cause) => formatExecBatchError(cause, index, statement)));
            if (restoreRole !== undefined && revertsToLoginRole(statement)) {
              yield* session
                .exec(restoreRole)
                .pipe(Effect.mapError((cause) => formatExecBatchError(cause, index, restoreRole)));
            }
          }
          if (
            restoreRole !== undefined &&
            !(statements.length > 0 && revertsToLoginRole(statements[statements.length - 1]!))
          ) {
            yield* session
              .exec(restoreRole)
              .pipe(
                Effect.mapError((cause) =>
                  formatExecBatchError(cause, statements.length, restoreRole),
                ),
              );
          }
          if (version.length > 0) {
            yield* session
              .query(INSERT_MIGRATION_VERSION, [version, name, statements])
              .pipe(
                Effect.mapError((cause) =>
                  formatExecBatchError(cause, statements.length, INSERT_MIGRATION_VERSION),
                ),
              );
          }
        }).pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              yield* session.exec(cleanup).pipe(Effect.ignore);
              // Sequential statements ran outside a CLI transaction, so a failed
              // file's `RESET ROLE` survives the cleanup; restore best-effort.
              if (restoreRole !== undefined) {
                yield* session.exec(restoreRole).pipe(Effect.ignore);
              }
            }),
          ),
        );

      // Session settings must remain active for the nontransactional action, so no transaction
      // boundary is added around this branch.
      if (transactionMode === "none") {
        return yield* executeSequentially("RESET ALL");
      }

      // A file with authored transaction boundaries owns those semantics; execute statements
      // exactly as written and only record history after they all succeed.
      if (statements.some(hasTransactionControl)) {
        return yield* executeSequentially("ROLLBACK");
      }

      // The global statement index of the next statement to run, so error context stays accurate
      // across flushed batches and standalone statements.
      let pending: Array<string> = [];
      let executed = 0;

      const flushBatch = (final: boolean) =>
        Effect.gen(function* () {
          const recordVersion = final && version.length > 0;
          const trailingRestore = final ? restoreRole : undefined;
          if (pending.length === 0 && !recordVersion && trailingRestore === undefined) return;
          const batchStatements = pending;
          const operations: Array<DbBatchStatement> = [];
          // Injected role restores don't count toward `At statement: N`; track how
          // many precede each op so failures keep the file's own numbering (a
          // mid-file restore inherits its host statement's index; the trailing
          // restore and the history insert report the file's statement count).
          const injectedBefore: Array<number> = [];
          let injected = 0;
          let lastOpIsInjectedRestore = false;
          for (const sql of batchStatements) {
            operations.push({ sql });
            injectedBefore.push(injected);
            lastOpIsInjectedRestore = false;
            if (restoreRole !== undefined && revertsToLoginRole(sql)) {
              injected += 1;
              operations.push({ sql: restoreRole });
              injectedBefore.push(injected);
              lastOpIsInjectedRestore = true;
            }
          }
          if (trailingRestore !== undefined && !lastOpIsInjectedRestore) {
            operations.push({ sql: trailingRestore });
            injectedBefore.push(injected);
            injected += 1;
          }
          if (recordVersion) {
            operations.push({
              sql: INSERT_MIGRATION_VERSION,
              params: [version, name, statements],
            });
            injectedBefore.push(injected);
          }
          const base = executed;
          yield* session.execBatch(operations).pipe(
            Effect.mapError((cause) => {
              // The batch's connection failed, either on checkout or before any of
              // it reached the wire: there is no failing statement to name, so the
              // connect error is surfaced verbatim instead of `At statement: N`.
              if (cause instanceof DbConnectError) return cause;
              // `statementIndex` is set by every batch failure the driver raises; a
              // session that omits it can only have failed before the first statement.
              const raw = cause.statementIndex ?? 0;
              const globalIndex = base + raw - (injectedBefore[raw] ?? injected);
              return formatExecBatchError(
                cause,
                globalIndex,
                operations[raw]?.sql ?? statements[globalIndex] ?? INSERT_MIGRATION_VERSION,
              );
            }),
          );
          pending = [];
          executed += batchStatements.length;
        });

      for (const statement of statements) {
        if (isPipelineIncompatible(statement)) {
          // Flush the open batch, then run the incompatible statement on its own (no
          // surrounding transaction) so PostgreSQL accepts it.
          yield* flushBatch(false);
          const index = executed;
          yield* session
            .exec(statement)
            .pipe(Effect.mapError((cause) => formatExecBatchError(cause, index, statement)));
          executed += 1;
        } else {
          pending.push(statement);
        }
      }
      yield* flushBatch(true);
    }).pipe(
      Effect.mapError((error) =>
        // A batch connection failure is not an execution failure: it keeps its own
        // error class (and `suggestion`) all the way out, exactly like the connect
        // failure a caller would have seen from `connect` itself, instead of being
        // relabeled as this file's statement-execution failure.
        error instanceof DbConnectError
          ? error
          : mapError(errorMessage(error), "exec", formattedExecBatchDbError(error)),
      ),
    );
  });

/**
 * Clears any connection settings a prior statement on the same session may have changed (e.g.
 * `set_config('search_path', …)`), run before each migration's batch. Only the migration-apply
 * path does this — `seedGlobals` (role/globals files) must not, so this is a caller
 * responsibility, never inside `execMigrationBatch`.
 */
const resetConnectionState = <E>(
  session: DbSession,
  mapError: (message: string) => E,
): Effect.Effect<void, E> =>
  session.exec("RESET ALL").pipe(Effect.mapError((e) => mapError(errorMessage(e))));

/**
 * Applies a single migration file to the connected database and records it in
 * `supabase_migrations.schema_migrations`: `RESET ALL` first to clear any session state leaked by
 * a prior file, then create the history table, then run the file's statements plus the history
 * insert.
 *
 * `mapError` lets the caller tag the failure (e.g. `PgDeltaDeclarativeApplyError`). Statement
 * failures also expose their structured PostgreSQL error so local replay can classify precise
 * SQLSTATE/object combinations without parsing formatted context.
 */
export const applyMigrationFile = <E>(
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationPath: string,
  mapError: (message: string, dbError?: DbExecError) => E,
): Effect.Effect<void, E | DbConnectError> =>
  Effect.gen(function* () {
    yield* resetConnectionState(session, mapError);
    yield* createMigrationTable(session).pipe(Effect.mapError((e) => mapError(errorMessage(e))));
    yield* execMigrationBatch(
      session,
      fs,
      path,
      migrationPath,
      (message, _phase, dbError) => mapError(message, dbError),
      false,
    );
  });

/**
 * Applies a list of pending migration files: creates the history table once when there is
 * anything to apply, then for each file emits `Applying migration <name>...` to stderr, resets
 * connection state, and runs it transactionally.
 */
export const applyMigrations = <E>(
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  pending: ReadonlyArray<string>,
  mapError: (message: string) => E,
): Effect.Effect<void, E | DbConnectError, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    if (pending.length === 0) return;
    yield* createMigrationTable(session).pipe(Effect.mapError((e) => mapError(errorMessage(e))));
    // Sorted by version, not file name, so callers passing a name-ordered listing (`db reset`,
    // the shadow-database replay) apply files in the same order `db push` does. Idempotent for
    // callers that already sorted.
    for (const migrationPath of sortMigrationPathsByVersion(pending)) {
      yield* output.raw(`Applying migration ${path.basename(migrationPath)}...\n`, "stderr");
      yield* resetConnectionState(session, mapError);
      yield* execMigrationBatch(session, fs, path, migrationPath, mapError, false);
    }
  });

/**
 * Applies custom-role/globals files: for each file, emits `Seeding globals from <name>...` to
 * stderr and runs it transactionally, without inserting a migration history row, creating the
 * history table, or running `RESET ALL`.
 */
export const seedGlobals = <E>(
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  globals: ReadonlyArray<string>,
  mapError: (message: string) => E,
): Effect.Effect<void, E | DbConnectError, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    for (const globalPath of globals) {
      yield* output.raw(`Seeding globals from ${path.basename(globalPath)}...\n`, "stderr");
      yield* execMigrationBatch(session, fs, path, globalPath, mapError, true);
    }
  });

/**
 * Runs one SQL file's statements transactionally, without `seedGlobals`'s per-file stderr
 * message, history row, history table, or `RESET ALL` — same batching semantics as `seedGlobals`
 * with `forceNoVersion: true`, just silent. Used by callers that run a batch directly on an
 * in-memory SQL constant (written to a temp file first, since this module only reads files) and
 * would otherwise print an unwanted extra line.
 *
 * `displayPath`, when given, is the path a read-failure's wrapped message should report instead
 * of `filePath` — see `execMigrationBatch`'s comment on why the two can differ. `projectEnv`,
 * when given, is forwarded to {@link checkScannerBufferSize} via `execMigrationBatch`.
 */
export const execSqlFile = <E>(
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  filePath: string,
  mapError: (message: string, phase: "read" | "exec") => E,
  displayPath?: string,
  projectEnv?: Readonly<Record<string, string>>,
): Effect.Effect<void, E | DbConnectError> =>
  execMigrationBatch(session, fs, path, filePath, mapError, true, displayPath, projectEnv);

/**
 * Applies the experimental declarative schema-files branch. Reads `schema_paths` via the shared
 * glob ({@link sqlFilesGlob}), then runs each matched file's statements with {@link execSqlFile}
 * in glob order — no history table, no history row, and no `RESET ALL` between files (a
 * stepped-down session's role re-assert at each file's end is the one exception).
 *
 * Callers gate the call on `--experimental` + no resolved version + pg-delta disabled themselves;
 * this function only performs the branch's body and never re-checks the gate.
 *
 * Two behaviors that would otherwise look like bugs are intentional:
 * - An empty `schema_paths` (the `supabase init` default) silently applies nothing and succeeds.
 * - A partial glob failure is silently dropped: per-pattern warnings only surface when no pattern
 *   matched anything at all.
 *
 * On a per-file execution failure, attaches `"See schema file: <file>"` as a suggestion via the
 * optional second argument of `mapError`; a file-read failure carries no suggestion.
 *
 * `projectEnv` is forwarded to {@link checkScannerBufferSize} via `execSqlFile`.
 */
export const applySchemaFiles = <E>(
  session: DbSession,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  schemaPaths: ReadonlyArray<string>,
  mapError: (message: string, suggestion?: string) => E,
  projectEnv: Readonly<Record<string, string>> = {},
): Effect.Effect<void, E | DbConnectError> =>
  Effect.gen(function* () {
    const { files, warnings } = yield* sqlFilesGlob(fs, path, schemaPaths, workdir);
    if (files.length === 0) {
      // Succeeds when there were no patterns to glob at all; fails with the joined per-pattern
      // warnings otherwise.
      if (warnings.length > 0) {
        return yield* Effect.fail(mapError(warnings.join("\n")));
      }
      return;
    }
    for (const file of files) {
      const absolutePath = path.isAbsolute(file) ? file : path.join(workdir, file);
      // `file` is workdir-relative when the declared pattern was relative, verbatim when
      // absolute — passed through as the display path so a read failure reports it instead of
      // the `absolutePath` the real read needs.
      yield* execSqlFile(
        session,
        fs,
        path,
        absolutePath,
        (message, phase) =>
          phase === "exec"
            ? mapError(message, `See schema file: ${bold(file)}`)
            : mapError(message),
        file,
        projectEnv,
      );
    }
  });
