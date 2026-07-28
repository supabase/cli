import { Data } from "effect";

/**
 * Opening a Postgres connection failed. Mirrors Go's `pgx`/`pgconn` connect
 * failures surfaced by `utils.ConnectByConfig`
 * (`apps/cli-go/internal/utils/connect.go`). The `suggestion` carries Go's
 * `utils.CmdSuggestion` text when the connect path sets one.
 */
export class LegacyDbConnectError extends Data.TaggedError("LegacyDbConnectError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {}

/**
 * Executing a SQL statement against an open connection failed. Mirrors the Go
 * `conn.Exec` error sites in `apps/cli-go/internal/db/test/test.go`.
 */
export class LegacyDbExecError extends Data.TaggedError("LegacyDbExecError")<{
  readonly message: string;
  /**
   * Postgres SQLSTATE (e.g. `42P01` undefined_table), extracted from the driver
   * error's `cause` chain when present. Lets callers match Go's error-code checks
   * (`pgerrcode.*`) instead of fuzzy message matching — e.g. suppressing only a
   * missing migration-history table, not an undefined column.
   */
  readonly code?: string;
  /**
   * Postgres `Detail` field of a server ErrorResponse (Go's `pgErr.Detail`).
   * Only set for server errors that carry a non-empty detail; the migration-apply
   * error context renders it on its own line, matching Go's `ExecBatch`
   * (`pkg/migration/file.go:99-101`).
   */
  readonly detail?: string;
  /**
   * Postgres error cursor of a server ErrorResponse (Go's `pgErr.Position`): a
   * 1-based index into the failing statement. Only set when the server reported a
   * position > 0. The migration-apply error context uses it to render Go's `^`
   * caret under the error position (`pkg/migration/file.go:98`, `markError`).
   */
  readonly position?: number;
}> {}

/**
 * A server-side `COPY (...) TO STDOUT` stream failed. Mirrors Go's
 * `copyToCSV` (`apps/cli-go/internal/inspect/report.go:64-77`), where
 * `conn.CopyTo` returns `failed to copy output: %w`. Raised by the driver's
 * `copyToCsv`; the report handler maps a subsequent file-write failure to its
 * own `failed to create output file` error (Go raises that one first, when it
 * opens the file before copying — the TS port collects the bytes first, so the
 * two messages still match Go's text on the matching failure).
 */
export class LegacyDbCopyError extends Data.TaggedError("LegacyDbCopyError")<{
  readonly message: string;
}> {}
