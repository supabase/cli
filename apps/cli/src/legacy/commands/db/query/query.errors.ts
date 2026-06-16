import { Data } from "effect";

/**
 * No SQL was provided by any source. Byte-matches Go's
 * `"no SQL query provided. Pass SQL as an argument, via --file, or pipe to stdin"`
 * (`apps/cli-go/internal/db/query/query.go` `ResolveSQL`).
 */
export class LegacyDbQueryNoSqlError extends Data.TaggedError("LegacyDbQueryNoSqlError")<{
  readonly message: string;
}> {}

/** Stdin was piped but empty. Byte-matches Go's `"no SQL provided via stdin"`. */
export class LegacyDbQueryNoStdinSqlError extends Data.TaggedError("LegacyDbQueryNoStdinSqlError")<{
  readonly message: string;
}> {}

/** `--file` could not be read. Byte-matches Go's `"failed to read SQL file: " + err`. */
export class LegacyDbQueryReadFileError extends Data.TaggedError("LegacyDbQueryReadFileError")<{
  readonly message: string;
}> {}

/**
 * `--linked` was used without an access token. Mirrors Go's PreRunE, which
 * returns `utils.ErrMissingToken` with the suggestion `Run supabase login first.`
 * (`apps/cli-go/cmd/db.go:300-307`).
 */
export class LegacyDbQueryLoginRequiredError extends Data.TaggedError(
  "LegacyDbQueryLoginRequiredError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {}

/** Query execution failed. Byte-matches Go's `"failed to execute query: " + err`. */
export class LegacyDbQueryExecError extends Data.TaggedError("LegacyDbQueryExecError")<{
  readonly message: string;
}> {}

/**
 * More than one of `--db-url` / `--linked` / `--local` was set. Reproduces
 * cobra's `dbQueryCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")`
 * (`apps/cli-go/cmd/db.go:526`) `ValidateFlagGroups` error byte-for-byte, so the
 * invocation fails before any SQL runs.
 */
export class LegacyDbQueryMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyDbQueryMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {}

/**
 * The linked Management API returned a non-201 status. Byte-matches Go's
 * `"unexpected status %d: %s"` (`RunLinked`).
 */
export class LegacyDbQueryUnexpectedStatusError extends Data.TaggedError(
  "LegacyDbQueryUnexpectedStatusError",
)<{
  readonly message: string;
}> {}
