import { Data } from "effect";

/**
 * Tagged errors for `db lint`, one per Go failure path
 * (`internal/db/lint/lint.go`). The `message` byte-matches Go's `errors.Errorf`
 * / `fmt.Errorf` text so text-mode stderr stays identical.
 *
 * Connection failures are surfaced by the shared `LegacyDbConnectError` from the
 * connection layer — not re-wrapped here.
 */

/** cobra `MarkFlagsMutuallyExclusive("db-url", "linked", "local")` (`db.go`). */
export class LegacyDbLintMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyDbLintMutuallyExclusiveFlagsError",
)<{ readonly message: string }> {}

/** `failed to begin transaction: %w` (`lint.go:111`). */
export class LegacyDbLintBeginTxError extends Data.TaggedError("LegacyDbLintBeginTxError")<{
  readonly message: string;
}> {}

/** `failed to list schemas: %w` (`drop.go:46`, via `ListUserSchemas`). */
export class LegacyDbLintListSchemasError extends Data.TaggedError("LegacyDbLintListSchemasError")<{
  readonly message: string;
}> {}

/** `failed to enable pgsql_check: %w` (`lint.go:126`). */
export class LegacyDbLintEnableCheckError extends Data.TaggedError("LegacyDbLintEnableCheckError")<{
  readonly message: string;
}> {}

/** `failed to query rows: %w` (`lint.go:140`). */
export class LegacyDbLintQueryError extends Data.TaggedError("LegacyDbLintQueryError")<{
  readonly message: string;
}> {}

/** `failed to marshal json: %w` (`lint.go:151`). */
export class LegacyDbLintMalformedJsonError extends Data.TaggedError(
  "LegacyDbLintMalformedJsonError",
)<{ readonly message: string }> {}

/** `fail-on is set to %s, non-zero exit` (`lint.go:72`). */
export class LegacyDbLintFailOnError extends Data.TaggedError("LegacyDbLintFailOnError")<{
  readonly message: string;
}> {}
