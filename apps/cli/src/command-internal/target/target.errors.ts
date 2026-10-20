import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

/** Several of `--remote`, `--linked`, `--db-url`, `--local`, or two different `--remote` values. */
export class TargetSelectorConflictError extends Data.TaggedError("TargetSelectorConflictError")<{
  readonly flags: ReadonlyArray<string>;
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `--project-ref` cannot be combined with `--remote=<value>`, `--local` or `--db-url`. */
export class TargetProjectRefConflictError extends Data.TaggedError(
  "TargetProjectRefConflictError",
)<{
  readonly conflictsWith: "--remote" | "--local" | "--db-url";
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `--db-url`, `--project-ref` or `--project-id` was passed an empty value. */
export class TargetEmptyValueError extends Data.TaggedError("TargetEmptyValueError")<{
  readonly flag: "--db-url" | "--project-ref" | "--project-id";
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `--project-ref` or `--project-id` was given a URL, not a project ref or branch name. */
export class TargetInvalidValueError extends Data.TaggedError("TargetInvalidValueError")<{
  readonly flag: "--project-ref" | "--project-id";
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** A command that acts on a parent project was given a branch name. */
export class TargetNeedsProjectError extends Data.TaggedError("TargetNeedsProjectError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * A bare `--remote` is followed by a word that names a branch, nearly names one, or could not be
 * checked because the branch listing failed; `status` is that failure's HTTP status, when it had
 * one, and `authFailure` says the access token was missing or invalid (`token` when only the
 * environment variable can fix it).
 */
export class TargetRemoteAmbiguousError extends Data.TaggedError("TargetRemoteAmbiguousError")<{
  readonly message: string;
  readonly suggestion?: string;
  readonly status?: number;
  readonly authFailure?: "login" | "token";
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.authFailure === "token") return actionability.authToken;
    if (this.status === 401 || this.status === 403) return statusCodeActionability(this.status);
    if (this.authFailure === "login") return actionability.authLogin;
    return actionability.provideFlags;
  }
}

/** `--password` was given while the resolved target is not a linked project. */
export class TargetPasswordConflictError extends Data.TaggedError("TargetPasswordConflictError")<{
  readonly target: "local" | "db-url";
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export type TargetSelectorError =
  | TargetSelectorConflictError
  | TargetProjectRefConflictError
  | TargetEmptyValueError
  | TargetInvalidValueError;
