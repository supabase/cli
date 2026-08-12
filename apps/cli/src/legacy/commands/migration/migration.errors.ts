import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Conflicting database-target flags. Matches the established
 * mutually-exclusive-flags error text for `db-url`/`linked`/`local`. Shared by
 * list / fetch / repair / up / down / squash.
 */
export class LegacyMigrationTargetFlagsError extends Data.TaggedError(
  "LegacyMigrationTargetFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--db-url` combined with `--password`/`-p`. Matches the established
 * mutually-exclusive-flags error text for `db-url`/`password` (list / repair / squash).
 */
export class LegacyMigrationPasswordFlagsError extends Data.TaggedError(
  "LegacyMigrationPasswordFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * A positional version argument is not a valid integer. Matches the established
 * `failed to parse <v>: invalid version number` text.
 */
export class LegacyMigrationInvalidVersionError extends Data.TaggedError(
  "LegacyMigrationInvalidVersionError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * No local migration file matched the requested version glob. Matches the
 * established `glob supabase/migrations/<version>_*.sql: file does not exist`
 * text. Shared by repair (applied) and squash.
 */
export class LegacyMigrationFileNotFoundError extends Data.TaggedError(
  "LegacyMigrationFileNotFoundError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The user declined a confirmation prompt (overwrite / repair-all / revert).
 * Maps to a non-zero exit with no extra output.
 */
export class LegacyOperationCanceledError extends Data.TaggedError("LegacyOperationCanceledError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}
