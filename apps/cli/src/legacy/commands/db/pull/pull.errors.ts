import { Data } from "effect";

/**
 * Conflicting database-target flags. Reproduces cobra's
 * `MarkFlagsMutuallyExclusive("db-url", "linked", "local")` error byte-for-byte
 * (`apps/cli-go/cmd/db.go:472`).
 */
export class LegacyDbPullTargetFlagsError extends Data.TaggedError("LegacyDbPullTargetFlagsError")<{
  readonly message: string;
}> {}

/**
 * `--declarative` / `--use-pg-delta` combined with `--diff-engine`. Reproduces
 * cobra's `MarkFlagsMutuallyExclusive` for `[declarative diff-engine]` and
 * `[use-pg-delta diff-engine]` (`apps/cli-go/cmd/db.go:473-474`).
 */
export class LegacyDbPullEngineConflictError extends Data.TaggedError(
  "LegacyDbPullEngineConflictError",
)<{
  readonly message: string;
}> {}

/**
 * The remote migration history does not match local files. Byte-matches Go's
 * `errConflict` (`internal/db/pull/pull.go:35`); the actionable
 * `supabase migration repair` suggestion is attached separately.
 */
export class LegacyDbPullMigrationConflictError extends Data.TaggedError(
  "LegacyDbPullMigrationConflictError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {}

/**
 * The diff produced no schema changes. Byte-matches Go's `errInSync`
 * (`internal/db/pull/pull.go:34`). Like Go, this surfaces as a (non-zero exit)
 * error rather than a success — `db pull` returns it from `Run`, unlike `db diff`
 * which prints it and exits 0.
 */
export class LegacyDbPullInSyncError extends Data.TaggedError("LegacyDbPullInSyncError")<{
  readonly message: string;
}> {}

/**
 * Writing the migration file / updating the remote migration-history table failed.
 * Wraps Go's `failed to write migration file` / `failed to update migration table`.
 */
export class LegacyDbPullWriteError extends Data.TaggedError("LegacyDbPullWriteError")<{
  readonly message: string;
}> {}

/**
 * The initial-pull pg_dump container exited non-zero. Go's `dumpRemoteSchema`
 * (`internal/db/pull/pull.go:144-158`) propagates the `dump.RunWithPoolerFallback`
 * error; byte-matches the dump's `"error running container: exit " + code`. Carries
 * the same optional IPv6 transaction-pooler hint the dump path attaches, which
 * `Output.fail` prints bare on stderr after the message.
 */
export class LegacyDbPullDumpError extends Data.TaggedError("LegacyDbPullDumpError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {}
