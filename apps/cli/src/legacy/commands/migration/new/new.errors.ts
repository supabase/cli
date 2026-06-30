import { Data } from "effect";

/**
 * Creating the migrations directory or writing the new migration file failed.
 * Wraps Go's `failed to open migration file` / `MkdirIfNotExistFS` errors
 * (`internal/migration/new/new.go:15-22`).
 */
export class LegacyMigrationNewWriteError extends Data.TaggedError("LegacyMigrationNewWriteError")<{
  readonly message: string;
}> {}
