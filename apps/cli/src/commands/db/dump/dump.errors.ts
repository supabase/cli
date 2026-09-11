import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * `--use-copy` / `--exclude` were passed without `--data-only`; message text
 * is an established output contract.
 */
export class DbDumpRequiresDataOnlyError extends Data.TaggedError("DbDumpRequiresDataOnlyError")<{
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
export class DbDumpMutuallyExclusiveFlagsError extends Data.TaggedError(
  "DbDumpMutuallyExclusiveFlagsError",
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
export class DbDumpOpenFileError extends Data.TaggedError("DbDumpOpenFileError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * pg_dump exited non-zero. Container dumps keep
 * `"error running container: exit " + code`; native PATH dumps use
 * `"error running pg_dump: exit " + code` (or `pg_dumpall`).
 */
export class DbDumpRunError extends Data.TaggedError("DbDumpRunError")<{
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
