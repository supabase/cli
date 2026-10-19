import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/** More than one of `--remote`, `--linked`, `--db-url` and `--local` was set. */
export class TargetSelectorConflictError extends Data.TaggedError("TargetSelectorConflictError")<{
  readonly flags: ReadonlyArray<string>;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `--project-ref` names a project, so it cannot be combined with `--remote=<value>`, `--local` or `--db-url`. */
export class TargetProjectRefConflictError extends Data.TaggedError(
  "TargetProjectRefConflictError",
)<{
  readonly conflictsWith: "--remote" | "--local" | "--db-url";
  readonly message: string;
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

/** A command that acts on a project was given a database URL. */
export class TargetNeedsProjectError extends Data.TaggedError("TargetNeedsProjectError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** A bare `--remote` is followed by a word that names a branch (or whose branches could not be listed), so the word is probably the branch. */
export class TargetRemoteAmbiguousError extends Data.TaggedError("TargetRemoteAmbiguousError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
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
  | TargetNeedsProjectError;
