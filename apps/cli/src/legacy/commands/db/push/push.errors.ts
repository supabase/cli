import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Conflicting database-target flags. Reproduces cobra's
 * `MarkFlagsMutuallyExclusive("db-url", "linked", "local")` error byte-for-byte
 * (`apps/cli-go/cmd/db.go:526`).
 */
export class LegacyDbPushTargetFlagsError extends Data.TaggedError("LegacyDbPushTargetFlagsError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Remote migration versions are missing from the local directory. Byte-matches
 * Go's `migration.ErrMissingLocal` (`pkg/migration/apply.go:16`); the
 * `migration repair` / `db pull` suggestion is attached (Go's `CmdSuggestion`).
 */
export class LegacyDbPushMissingLocalError extends Data.TaggedError(
  "LegacyDbPushMissingLocalError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.migrationDrift;
  }
}

/**
 * Local migration files are ordered before the remote head and `--include-all`
 * was not passed. Byte-matches Go's `migration.ErrMissingRemote`
 * (`pkg/migration/apply.go:15`); the `--include-all` suggestion is attached.
 */
export class LegacyDbPushMissingRemoteError extends Data.TaggedError(
  "LegacyDbPushMissingRemoteError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.migrationDrift;
  }
}

/**
 * The user declined a confirmation prompt. Go returns `errors.New(context.Canceled)`
 * (`internal/db/push/push.go:80,91,110`), rendered as `context canceled`.
 */
export class LegacyDbPushCancelledError extends Data.TaggedError("LegacyDbPushCancelledError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

/** Locating `supabase/roles.sql` failed (Go's `failed to find custom roles: %w`). */
export class LegacyDbPushRolesError extends Data.TaggedError("LegacyDbPushRolesError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * A migration / seed / globals / vault statement failed while applying. Carries
 * the underlying Postgres error (with Go's `At statement: <n>` context for
 * migrations) so stderr matches Go's propagated error.
 */
export class LegacyDbPushApplyError extends Data.TaggedError("LegacyDbPushApplyError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}
