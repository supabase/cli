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
}> {}
