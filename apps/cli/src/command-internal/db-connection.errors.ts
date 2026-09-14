import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * Opening a Postgres connection failed. `suggestion` carries actionable follow-up text when the
 * connect path sets one.
 */
export class DbConnectError extends Data.TaggedError("DbConnectError")<{
  readonly message: string;
  readonly suggestion?: string;
  /**
   * True when the failure was dial-level rather than a server, auth, or config error; the
   * fresh-db bootstrap's connect retry keys off this field.
   */
  readonly retryable?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/**
 * Executing a SQL statement against an open connection failed.
 */
export class DbExecError extends Data.TaggedError("DbExecError")<{
  readonly message: string;
  /**
   * Number of statements completed before an `execBatch` failure. This may equal
   * the batch length for a deferred Sync failure. Absent for `exec`/`query`.
   */
  readonly statementIndex?: number;
  /**
   * Postgres SQLSTATE (e.g. `42P01` undefined_table), extracted from the driver error's `cause`
   * chain when present. Lets callers match on error code instead of fuzzy message matching — e.g.
   * suppressing only a missing migration-history table, not an undefined column.
   */
  readonly code?: string;
  /**
   * Postgres `Detail` field of a server error response. Only set when the server reports one;
   * the migration-apply error context renders it on its own line.
   */
  readonly detail?: string;
  /**
   * Postgres error cursor of a server error response: a 1-based index into the failing
   * statement, present only when the server reports one > 0. The migration-apply error context
   * renders a `^` caret under it.
   */
  readonly position?: number;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * A server-side `COPY (...) TO STDOUT` stream failed. The report handler maps a later
 * file-write failure to its own separate error, since bytes are collected before the output
 * file is opened. See `inspect/report/SIDE_EFFECTS.md`, "Divergence on the query that was in
 * flight when `COPY` failed", for the on-disk consequences.
 */
export class DbCopyError extends Data.TaggedError("DbCopyError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}
