import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/**
 * Every worker failure carries the same shape the rest of the next shell uses:
 * a `detail` saying what happened and a `suggestion` naming the exact command
 * that fixes it. The POC's `→` recovery lines are this, rendered by the shared
 * output layer instead of by each command.
 */

export class InvalidWorkerNameError extends Data.TaggedError("InvalidWorkerNameError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class MissingWorkerNameError extends Data.TaggedError("MissingWorkerNameError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class UnknownWorkerRuntimeError extends Data.TaggedError("UnknownWorkerRuntimeError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class UnknownWorkerSizeError extends Data.TaggedError("UnknownWorkerSizeError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class WorkerDirectoryExistsError extends Data.TaggedError("WorkerDirectoryExistsError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--source` names a directory it is not allowed to name. Worth its own error
 * because the destination is a directory `--force` will delete outright, so a
 * value that resolves to the project root, `supabase/`, or anywhere outside the
 * project has to be refused before anything is removed.
 */
export class InvalidWorkerSourceError extends Data.TaggedError("InvalidWorkerSourceError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `[workers] root` names a directory it is not allowed to name. */
export class InvalidWorkersRootError extends Data.TaggedError("InvalidWorkersRootError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}
