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

/** A bare `push` found no workers to deploy — none named, none in the project. */
export class NoWorkersToDeployError extends Data.TaggedError("NoWorkersToDeployError")<{
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

export class WorkerSourceMissingError extends Data.TaggedError("WorkerSourceMissingError")<{
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

/** The deploy finished, and the build it started failed. */
export class WorkerBuildFailedError extends Data.TaggedError("WorkerBuildFailedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** The build never left `building` inside the CLI's polling budget. */
export class WorkerBuildTimeoutError extends Data.TaggedError("WorkerBuildTimeoutError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.apiStatus;
  }
}

/** PUTting the build context to the presigned slot failed. */
export class WorkerUploadFailedError extends Data.TaggedError("WorkerUploadFailedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/** Transport failure talking to the Management API. */
export class WorkersApiNetworkError extends Data.TaggedError("WorkersApiNetworkError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/**
 * The named worker is not deployed. `status`/`delete` share this verbatim: the
 * question "does this exist?" is asked of the API, never of a local directory.
 */
export class WorkerNotDeployedError extends Data.TaggedError("WorkerNotDeployedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Workers are in private alpha: the routes answer 404 for a project that is not
 * enrolled, which is indistinguishable from an unknown worker at the transport
 * level — so this is only raised for the collection endpoints, where there is
 * no worker name that could have been wrong.
 */
export class WorkersUnavailableError extends Data.TaggedError("WorkersUnavailableError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/** Any other status the Workers routes answered with. */
export class WorkersApiUnexpectedStatusError extends Data.TaggedError(
  "WorkersApiUnexpectedStatusError",
)<{
  readonly detail: string;
  readonly suggestion: string;
  readonly status: number;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.apiStatus;
  }
}
