import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/** More than one of `--local`, `--linked` and `--db-url` was set. */
export class TargetSelectorConflictError extends Data.TaggedError("TargetSelectorConflictError")<{
  readonly flags: ReadonlyArray<string>;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `--project-ref` selects a linked project, so it cannot be combined with `--local` or `--db-url`. */
export class TargetProjectRefConflictError extends Data.TaggedError(
  "TargetProjectRefConflictError",
)<{
  readonly conflictsWith: "--local" | "--db-url";
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `--db-url` or `--project-ref` was passed an empty value. */
export class TargetEmptyValueError extends Data.TaggedError("TargetEmptyValueError")<{
  readonly flag: "--db-url" | "--project-ref";
  readonly message: string;
  readonly suggestion: string;
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
  | TargetEmptyValueError;
