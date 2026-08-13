import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * `--use-copy` / `--exclude` were passed without `--data-only`; message text
 * is an established output contract.
 */
export class LegacyDbDumpRequiresDataOnlyError extends Data.TaggedError(
  "LegacyDbDumpRequiresDataOnlyError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Two mutually exclusive flags were set together; message text is an
 * established output contract.
 */
export class LegacyDbDumpMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyDbDumpMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Failed to open the `--file` output path; message text
 * (`"failed to open dump file: " + err`) is an established output contract.
 */
export class LegacyDbDumpOpenFileError extends Data.TaggedError("LegacyDbDumpOpenFileError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * The pg_dump container exited non-zero; message text
 * (`"error running container: exit " + code`) is an established output contract.
 */
export class LegacyDbDumpRunError extends Data.TaggedError("LegacyDbDumpRunError")<{
  readonly message: string;
  // An actionable hint attached to a failed dump — e.g. the IPv6
  // transaction-pooler guidance. `Output.fail` prints it bare on stderr after
  // the error message.
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}
