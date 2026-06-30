import { Data } from "effect";

/**
 * A remote migration version is not present in the local migrations directory.
 * Byte-matches Go's `ErrMissingLocal` (`pkg/migration/apply.go:16`); the
 * `migration repair --status reverted ...` suggestion is attached separately.
 */
export class LegacyMigrationMissingLocalError extends Data.TaggedError(
  "LegacyMigrationMissingLocalError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {}

/**
 * Out-of-order local migrations exist before the last remote migration, and
 * `--include-all` was not set. Byte-matches Go's `ErrMissingRemote`
 * (`pkg/migration/apply.go:15`); the `--include-all` suggestion is attached
 * separately.
 */
export class LegacyMigrationMissingRemoteError extends Data.TaggedError(
  "LegacyMigrationMissingRemoteError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {}
