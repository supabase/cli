import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Conflicting database-target flags (`db-url`/`linked`/`local`); message text
 * is an established output contract.
 */
export class DbResetTargetFlagsError extends Data.TaggedError("DbResetTargetFlagsError")<{
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
export class DbResetVersionFlagsError extends Data.TaggedError("DbResetVersionFlagsError")<{
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
export class DbResetInvalidVersionError extends Data.TaggedError("DbResetInvalidVersionError")<{
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
export class DbResetMigrationFileError extends Data.TaggedError("DbResetMigrationFileError")<{
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
export class DbResetCancelledError extends Data.TaggedError("DbResetCancelledError")<{
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
export class DbResetApplyError extends Data.TaggedError("DbResetApplyError")<{
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
export class DbResetLastFlagError extends Data.TaggedError("DbResetLastFlagError")<{
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
export class DbResetSeedFlagsError extends Data.TaggedError("DbResetSeedFlagsError")<{
  readonly message: string;
  /** Actionable hint rendered as a `Suggestion:` line. */
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
