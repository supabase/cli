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
export class LegacyDbPushTargetFlagsError extends Data.TaggedError("LegacyDbPushTargetFlagsError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Remote migration versions are missing from the local directory; message
 * text is an established output contract. The `migration repair` / `db pull`
 * suggestion is attached.
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
 * was not passed; message text is an established output contract. The
 * `--include-all` suggestion is attached.
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
 * The user declined a confirmation prompt; message text (`context canceled`)
 * is an established output contract.
 */
export class LegacyDbPushCancelledError extends Data.TaggedError("LegacyDbPushCancelledError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

/** Locating `supabase/roles.sql` failed; message text (`failed to find custom roles: %w`) is an established output contract. */
export class LegacyDbPushRolesError extends Data.TaggedError("LegacyDbPushRolesError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/**
 * A migration / seed / globals / vault statement failed while applying.
 * Carries the underlying Postgres error (with an `At statement: <n>` context
 * for migrations); message text is an established output contract.
 */
export class LegacyDbPushApplyError extends Data.TaggedError("LegacyDbPushApplyError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}
