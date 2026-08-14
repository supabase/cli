import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * Tagged errors for `db lint`, one per failure path. Message text is an
 * established output contract.
 *
 * Connection failures are surfaced by the shared `LegacyDbConnectError` from the
 * connection layer — not re-wrapped here.
 */

/** Conflicting `db-url`/`linked`/`local` flags; message text is an established output contract. */
export class LegacyDbLintMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyDbLintMutuallyExclusiveFlagsError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `failed to begin transaction: %w`; message text is an established output contract. */
export class LegacyDbLintBeginTxError extends Data.TaggedError("LegacyDbLintBeginTxError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/** `failed to list schemas: %w`; message text is an established output contract. */
export class LegacyDbLintListSchemasError extends Data.TaggedError("LegacyDbLintListSchemasError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** `failed to enable pgsql_check: %w`; message text is an established output contract. */
export class LegacyDbLintEnableCheckError extends Data.TaggedError("LegacyDbLintEnableCheckError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** `failed to query rows: %w`; message text is an established output contract. */
export class LegacyDbLintQueryError extends Data.TaggedError("LegacyDbLintQueryError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** `failed to marshal json: %w`; message text is an established output contract. */
export class LegacyDbLintMalformedJsonError extends Data.TaggedError(
  "LegacyDbLintMalformedJsonError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** `fail-on is set to %s, non-zero exit`; message text is an established output contract. */
export class LegacyDbLintFailOnError extends Data.TaggedError("LegacyDbLintFailOnError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}
