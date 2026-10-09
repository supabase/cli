import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Tagged errors for `db lint`, one per failure path. Message text is an
 * established output contract.
 *
 * Connection failures are surfaced by the shared `DbConnectError` from the
 * connection layer — not re-wrapped here.
 */

/** Conflicting `db-url`/`linked`/`local` flags; message text is an established output contract. */
export class DbLintMutuallyExclusiveFlagsError extends Data.TaggedError(
  "DbLintMutuallyExclusiveFlagsError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `failed to begin transaction: <cause>`; message text is an established output contract. */
export class DbLintBeginTxError extends Data.TaggedError("DbLintBeginTxError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/** `failed to list schemas: <cause>`; message text is an established output contract. */
export class DbLintListSchemasError extends Data.TaggedError("DbLintListSchemasError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** `failed to enable pgsql_check: <cause>`; message text is an established output contract. */
export class DbLintEnableCheckError extends Data.TaggedError("DbLintEnableCheckError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** `failed to query rows: <cause>`; message text is an established output contract. */
export class DbLintQueryError extends Data.TaggedError("DbLintQueryError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** `failed to marshal json: <cause>`; message text is an established output contract. */
export class DbLintMalformedJsonError extends Data.TaggedError("DbLintMalformedJsonError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}

/** `fail-on is set to <level>, non-zero exit`; message text is an established output contract. */
export class DbLintFailOnError extends Data.TaggedError("DbLintFailOnError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbFinding;
  }
}
