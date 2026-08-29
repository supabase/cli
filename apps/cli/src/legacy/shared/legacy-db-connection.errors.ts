import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * Opening a Postgres connection failed. Mirrors `pgx`/`pgconn` connect
 * failures surfaced by `utils.ConnectByConfig`. The `suggestion` carries the
 * `utils.CmdSuggestion` text when the connect path sets one.
 */
export class LegacyDbConnectError extends Data.TaggedError("LegacyDbConnectError")<{
  readonly message: string;
  readonly suggestion?: string;
  /**
   * True when the failure was dial-level (`legacyIsDialFailure`) rather than
   * a server, auth, or config error — the fresh-db bootstrap's connect retry
   * keys off this field (`db-setup.ts`, #6136).
   */
  readonly retryable?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/**
 * Executing a SQL statement against an open connection failed. Mirrors the
 * established `conn.Exec` error sites.
 */
export class LegacyDbExecError extends Data.TaggedError("LegacyDbExecError")<{
  readonly message: string;
  /**
   * Number of statements completed before an `execBatch` failure. This may equal
   * the batch length for a deferred Sync failure. Absent for `exec`/`query`.
   */
  readonly statementIndex?: number;
  /**
   * Which CLI-injected transaction wrapper failed, when the failure was BEGIN's
   * or COMMIT's rather than a caller statement's. Absent otherwise.
   */
  readonly transactionPhase?: "begin" | "commit";
  /**
   * Postgres SQLSTATE (e.g. `42P01` undefined_table), extracted from the driver
   * error's `cause` chain when present. Lets callers match Go's error-code checks
   * (`pgerrcode.*`) instead of fuzzy message matching — e.g. suppressing only a
   * missing migration-history table, not an undefined column.
   */
  readonly code?: string;
  /**
   * Postgres `Detail` field of a server ErrorResponse (`pgErr.Detail`).
   * Only set for server errors that carry a non-empty detail; the migration-apply
   * error context renders it on its own line, matching `ExecBatch`.
   */
  readonly detail?: string;
  /**
   * Postgres error cursor of a server ErrorResponse (`pgErr.Position`): a
   * 1-based index into the failing statement. Only set when the server reported a
   * position > 0. The migration-apply error context uses it to render `^`
   * caret under the error position (`markError`).
   */
  readonly position?: number;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * A server-side `COPY (...) TO STDOUT` stream failed. Mirrors
 * `copyToCSV`, where
 * `conn.CopyTo` returns `failed to copy output: %w`. Raised by the driver's
 * `copyToCsv`; the report handler maps a subsequent file-write failure to its
 * own `failed to create output file` error (the reference implementation raises that
 * one first, when it
 * opens the file before copying — the TS port collects the bytes first, so the
 * two messages still match on the matching failure).
 *
 * That "collect bytes first" ordering is also where the two sides diverge on
 * disk, not just in message text — Go opens the output file (`O_TRUNC`) before
 * running the query, so a failing query still leaves a file behind; TS never
 * writes one. See `inspect/report/SIDE_EFFECTS.md` ("Divergence on the query
 * that was in flight when `COPY` failed") for the file-residue consequences.
 */
export class LegacyDbCopyError extends Data.TaggedError("LegacyDbCopyError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}
