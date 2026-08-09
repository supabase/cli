import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * No SQL was provided by any source. Byte-matches Go's
 * `"no SQL query provided. Pass SQL as an argument, via --file, or pipe to stdin"`
 * (`apps/cli-go/internal/db/query/query.go` `ResolveSQL`).
 */
export class LegacyDbQueryNoSqlError extends Data.TaggedError("LegacyDbQueryNoSqlError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** Stdin was piped but empty. Byte-matches Go's `"no SQL provided via stdin"`. */
export class LegacyDbQueryNoStdinSqlError extends Data.TaggedError("LegacyDbQueryNoStdinSqlError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `--file` could not be read. Byte-matches Go's `"failed to read SQL file: " + err`. */
export class LegacyDbQueryReadFileError extends Data.TaggedError("LegacyDbQueryReadFileError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--linked` was used without an access token. Mirrors Go's PreRunE, which
 * returns `utils.ErrMissingToken` with the suggestion `Run supabase login first.`
 * (`apps/cli-go/cmd/db.go:300-307`).
 */
export class LegacyDbQueryLoginRequiredError extends Data.TaggedError(
  "LegacyDbQueryLoginRequiredError",
)<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}

/** Query execution failed. Byte-matches Go's `"failed to execute query: " + err`. */
export class LegacyDbQueryExecError extends Data.TaggedError("LegacyDbQueryExecError")<{
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
 * More than one of `--db-url` / `--linked` / `--local` was set. Reproduces
 * cobra's `dbQueryCmd.MarkFlagsMutuallyExclusive("db-url", "linked", "local")`
 * (`apps/cli-go/cmd/db.go:526`) `ValidateFlagGroups` error byte-for-byte, so the
 * invocation fails before any SQL runs.
 */
export class LegacyDbQueryMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyDbQueryMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The linked Management API returned a non-201 status. Byte-matches Go's
 * `"unexpected status %d: %s"` (`RunLinked`).
 */
export class LegacyDbQueryUnexpectedStatusError extends Data.TaggedError(
  "LegacyDbQueryUnexpectedStatusError",
)<{
  readonly status: number;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // The endpoint executes the user's SQL: a 400 is the remote twin of the
    // local LegacyDbQueryExecError (syntax/constraint failures in user SQL).
    if (this.status === 400) {
      return { ...actionability.dbFinding, fingerprint_suffix: "query" };
    }
    return statusCodeActionability(this.status);
  }
}
