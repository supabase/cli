import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * No SQL was provided by any source; message text
 * (`"no SQL query provided. Pass SQL as an argument, via --file, or pipe to
 * stdin"`) is an established output contract.
 */
export class DbQueryNoSqlError extends Data.TaggedError("DbQueryNoSqlError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** Stdin was piped but empty; message text (`"no SQL provided via stdin"`) is an established output contract. */
export class DbQueryNoStdinSqlError extends Data.TaggedError("DbQueryNoStdinSqlError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `--file` could not be read; message text (`"failed to read SQL file: " + err`) is an established output contract. */
export class DbQueryReadFileError extends Data.TaggedError("DbQueryReadFileError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--linked` was used without an access token; message text and the
 * `Run supabase login first.` suggestion are an established output contract.
 */
export class DbQueryLoginRequiredError extends Data.TaggedError("DbQueryLoginRequiredError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}

/** Query execution failed; message text (`"failed to execute query: " + err`) is an established output contract. */
export class DbQueryExecError extends Data.TaggedError("DbQueryExecError")<{
  readonly message: string;
  /**
   * Set when this failure came from the linked path's HTTP transport
   * (`httpClient.execute`/body read against `/v1/projects/{ref}/database/query`)
   * rather than the user's SQL failing to execute.
   */
  readonly transport?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.transport === true) {
      return { ...actionability.externalNetwork, fingerprint_suffix: "network" };
    }
    // The user's own SQL failed — same bucket as every sibling exec error.
    return actionability.dbFinding;
  }
}

/**
 * More than one of `--db-url` / `--linked` / `--local` was set; message text
 * is an established output contract, so the invocation fails before any SQL
 * runs.
 */
export class DbQueryMutuallyExclusiveFlagsError extends Data.TaggedError(
  "DbQueryMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The linked Management API returned a non-201 status; message text
 * (`"unexpected status %d: %s"`) is an established output contract.
 */
export class DbQueryUnexpectedStatusError extends Data.TaggedError("DbQueryUnexpectedStatusError")<{
  readonly status: number;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // The endpoint executes the user's SQL: a 400 is the remote twin of the
    // local DbQueryExecError (syntax/constraint failures in user SQL).
    if (this.status === 400) {
      return { ...actionability.dbFinding, fingerprint_suffix: "query" };
    }
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}
