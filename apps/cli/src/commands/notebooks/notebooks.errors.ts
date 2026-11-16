import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * One network / status pair covers every notebook route rather than one pair
 * per call: `push` and `pull` each walk the same five routes, and the failing
 * one is already named by the message the caller templates in ("failed to list
 * notebooks", "failed to update notebook <name>", …).
 */
export class NotebooksNetworkError extends Data.TaggedError("NotebooksNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class NotebooksUnexpectedStatusError extends Data.TaggedError(
  "NotebooksUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

/** A file under `supabase/notebooks/` is not readable, not JSON, or not a notebook. */
export class NotebookFileError extends Data.TaggedError("NotebookFileError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** The name given as an argument names no notebook on either side. */
export class NotebookNotFoundError extends Data.TaggedError("NotebookNotFoundError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** The single-notebook pull argument is not a Management API notebook UUID. */
export class NotebookIdError extends Data.TaggedError("NotebookIdError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Two project notebooks share one name. The API does not require notebook names
 * to be unique, but a directory of files does — so there is no way to say which
 * of them a local file corresponds to, and guessing would write one user's
 * notebook over another's.
 */
export class NotebookNameConflictError extends Data.TaggedError("NotebookNameConflictError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export class NotebooksEnvNotSupportedError extends Data.TaggedError(
  "NotebooksEnvNotSupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class NotebooksPaginationError extends Data.TaggedError("NotebooksPaginationError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}
