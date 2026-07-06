import { Data } from "effect";

/**
 * Conflicting database-target flags. Reproduces cobra's
 * `MarkFlagsMutuallyExclusive("db-url", "linked", "local")` (`cmd/db.go:573`).
 */
export class LegacyDbResetTargetFlagsError extends Data.TaggedError(
  "LegacyDbResetTargetFlagsError",
)<{
  readonly message: string;
}> {}

/**
 * `--version` and `--last` together. Reproduces cobra's
 * `MarkFlagsMutuallyExclusive("version", "last")` (`cmd/db.go:576`).
 */
export class LegacyDbResetVersionFlagsError extends Data.TaggedError(
  "LegacyDbResetVersionFlagsError",
)<{
  readonly message: string;
}> {}

/**
 * `--version` is not a valid integer. Byte-matches Go's
 * `failed to parse <v>: invalid version number` (`repair.go:24-29`).
 */
export class LegacyDbResetInvalidVersionError extends Data.TaggedError(
  "LegacyDbResetInvalidVersionError",
)<{
  readonly message: string;
}> {}

/**
 * No migration file matches `--version`. Byte-matches Go's
 * `glob supabase/migrations/<version>_*.sql: file does not exist`
 * (`repair.GetMigrationFile`).
 */
export class LegacyDbResetMigrationFileError extends Data.TaggedError(
  "LegacyDbResetMigrationFileError",
)<{
  readonly message: string;
}> {}

/**
 * The user declined the reset confirmation. Go returns
 * `errors.New(context.Canceled)` (`internal/db/reset/reset.go:248`).
 */
export class LegacyDbResetCancelledError extends Data.TaggedError("LegacyDbResetCancelledError")<{
  readonly message: string;
}> {}

/** A drop / migrate / seed / vault statement failed during the remote reset. */
export class LegacyDbResetApplyError extends Data.TaggedError("LegacyDbResetApplyError")<{
  readonly message: string;
}> {}

/**
 * The local database container is not running. Byte-matches Go's
 * `utils.ErrNotRunning` (`internal/utils/misc.go:116`), `"<aqua>supabase start</aqua>
 * is not running."`, returned by `AssertSupabaseDbIsRunning` before the local
 * reset (`internal/db/reset/reset.go:57`).
 */
export class LegacyDbResetNotRunningError extends Data.TaggedError("LegacyDbResetNotRunningError")<{
  readonly message: string;
}> {}

/**
 * `--last` was given a negative value. Go declares `--last` as an unsigned flag
 * (`UintVar`, `cmd/db.go`), so cobra rejects a negative at parse time. Byte-matches
 * cobra's parse error for `strconv.ParseUint`.
 */
export class LegacyDbResetLastFlagError extends Data.TaggedError("LegacyDbResetLastFlagError")<{
  readonly message: string;
}> {}

/**
 * Invalid `--sql-paths` usage. Byte-matches Go's `validateDbResetSeedFlags`
 * (`cmd/db.go`): `"--no-seed cannot be used with --sql-paths"` and
 * `"--sql-paths requires a non-empty path or glob pattern"`.
 */
export class LegacyDbResetSeedFlagsError extends Data.TaggedError("LegacyDbResetSeedFlagsError")<{
  readonly message: string;
  /**
   * Actionable hint rendered as a `Suggestion:` line, mirroring Go's
   * `validateDbResetSeedFlags` `utils.CmdSuggestion` (`cmd/db.go`).
   */
  readonly suggestion?: string;
}> {}
