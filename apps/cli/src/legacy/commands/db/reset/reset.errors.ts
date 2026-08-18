import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Conflicting database-target flags (`db-url`/`linked`/`local`); message text
 * is an established output contract.
 */
export class LegacyDbResetTargetFlagsError extends Data.TaggedError(
  "LegacyDbResetTargetFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--version` and `--last` together; message text is an established output
 * contract.
 */
export class LegacyDbResetVersionFlagsError extends Data.TaggedError(
  "LegacyDbResetVersionFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--version` is not a valid integer; message text (`invalid version number`,
 * returned unwrapped) is an established output contract — the
 * `failed to parse <v>:` wrapper is the `migration repair` path only.
 */
export class LegacyDbResetInvalidVersionError extends Data.TaggedError(
  "LegacyDbResetInvalidVersionError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * No migration file matches `--version`; message text
 * (`glob supabase/migrations/<version>_*.sql: file does not exist`) is an
 * established output contract.
 */
export class LegacyDbResetMigrationFileError extends Data.TaggedError(
  "LegacyDbResetMigrationFileError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The user declined the reset confirmation; message text (`context canceled`)
 * is an established output contract.
 */
export class LegacyDbResetCancelledError extends Data.TaggedError("LegacyDbResetCancelledError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

/**
 * A drop / migrate / seed / vault statement failed during the remote reset.
 * `suggestion` is set only by the `--experimental` schema-files apply branch
 * (`"See schema file: <Bold(fp)>"`); every other apply failure on this command
 * leaves it unset.
 */
export class LegacyDbResetApplyError extends Data.TaggedError("LegacyDbResetApplyError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * `--last` was given a negative value; `--last` is an unsigned flag, so a
 * negative value is rejected at parse time. Message text is an established
 * output contract.
 */
export class LegacyDbResetLastFlagError extends Data.TaggedError("LegacyDbResetLastFlagError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Invalid `--sql-paths` usage; message text
 * (`"--no-seed cannot be used with --sql-paths"` and
 * `"--sql-paths requires a non-empty path or glob pattern"`) is an
 * established output contract.
 */
export class LegacyDbResetSeedFlagsError extends Data.TaggedError("LegacyDbResetSeedFlagsError")<{
  readonly message: string;
  /** Actionable hint rendered as a `Suggestion:` line. */
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
