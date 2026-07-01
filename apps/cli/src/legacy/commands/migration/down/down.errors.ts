import { Data } from "effect";

/** `--last 0`. Byte-matches Go's `--last must be greater than 0` (`down.go:21`). */
export class LegacyMigrationLastZeroError extends Data.TaggedError("LegacyMigrationLastZeroError")<{
  readonly message: string;
}> {}

/**
 * `--last` >= the number of applied migrations. Byte-matches Go's
 * `--last must be smaller than total applied migrations: <total>` (`down.go:35`);
 * the `supabase db reset` suggestion is attached separately.
 */
export class LegacyMigrationLastTooLargeError extends Data.TaggedError(
  "LegacyMigrationLastTooLargeError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {}
