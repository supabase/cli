import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * Conflicting database-target flags. Matches the established
 * mutually-exclusive-flags error text for `db-url`/`linked`/`local`. Shared by
 * list / fetch / repair / up / down / squash.
 */
export class MigrationTargetFlagsError extends Data.TaggedError("MigrationTargetFlagsError")<{
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
export class MigrationPasswordFlagsError extends Data.TaggedError("MigrationPasswordFlagsError")<{
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
export class MigrationInvalidVersionError extends Data.TaggedError("MigrationInvalidVersionError")<{
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
export class MigrationFileNotFoundError extends Data.TaggedError("MigrationFileNotFoundError")<{
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
export class OperationCanceledError extends Data.TaggedError("OperationCanceledError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}
