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

/** pg_dump exited non-zero. Message text comes from `pgDumpClientExitMessage`. */
export class DbDumpRunError extends Data.TaggedError("DbDumpRunError")<{
  readonly message: string;
  /** Printed on stderr after the error (IPv6 pooler guidance, native client hint). */
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}
