import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../telemetry/error-actionability.ts";

/**
 * Every worker failure carries a `detail` saying what happened and a
 * `suggestion` naming the command that fixes it. The shared output layer renders
 * the pair, so no command formats its own recovery line.
 */

export class InvalidWorkerNameError extends Data.TaggedError("InvalidWorkerNameError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * A bare `new` had no name to scaffold under, and nowhere to ask for one. The name is the one
 * input this command can't default — it's the directory, the `config.toml` key, and the hostname
 * all at once — so with `-o` or no interactive terminal there's nothing to do but say so.
 */
export class MissingWorkerNameError extends Data.TaggedError("MissingWorkerNameError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * A symlink in the worker source points outside the build context.
 *
 * The archive is everything the server gets, with no install step and no view of the surrounding
 * repository, so a link whose target isn't also packaged arrives dangling — the catalog runtimes
 * boot without the dependency, or a Dockerfile build fails on `COPY`, both minutes later with
 * nothing naming the cause. Refused here instead. The common source is a package manager that
 * hoists dependencies to the repository root, outside the worker's own `node_modules`.
 */
export class WorkerSourceEscapingLinkError extends Data.TaggedError(
  "WorkerSourceEscapingLinkError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
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

/**
 * `config.toml` records a runtime this CLI does not offer. Raised by `push`, which reads a
 * worker's runtime back out of config; `new` writes one but never reads it.
 */
export class UnknownWorkerRuntimeError extends Data.TaggedError("UnknownWorkerRuntimeError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** As {@link UnknownWorkerRuntimeError}, for a recorded instance size. */
export class UnknownWorkerSizeError extends Data.TaggedError("UnknownWorkerSizeError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class UnknownWorkerExposureError extends Data.TaggedError("UnknownWorkerExposureError")<{
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
 * `--source` names a directory it isn't allowed to name — the starter files land at the resolved
 * destination, so a value resolving to the project root, `supabase/`, or anywhere outside the
 * project must be refused before anything is written.
 */
export class InvalidWorkerSourceError extends Data.TaggedError("InvalidWorkerSourceError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
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
 * Workers are in private alpha: an unenrolled project's routes answer 404, indistinguishable at
 * the transport level from an unknown worker — so this is only raised on collection endpoints,
 * where there's no worker name that could have been wrong.
 */
export class WorkersUnavailableError extends Data.TaggedError("WorkersUnavailableError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * The project ref names no project this account can see. Separated from {@link
 * WorkersUnavailableError} because both arrive as a 404 on the same routes, and suggesting alpha
 * enrolment for a project that doesn't exist would send someone somewhere that can't help.
 */
export class WorkerProjectNotFoundError extends Data.TaggedError("WorkerProjectNotFoundError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Any other status the Workers routes answered with. Classified from the status it carries rather
 * than bucketed as a generic service failure — a 401 is the user's to fix by logging in, a 403 by
 * getting access, and reporting either as `api_status` would blur the actionability signal.
 */
export class WorkersApiUnexpectedStatusError extends Data.TaggedError(
  "WorkersApiUnexpectedStatusError",
)<{
  readonly detail: string;
  readonly suggestion: string;
  readonly status: number;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

/** The user answered the `delete` confirmation with something other than the name. */
export class WorkerDeleteNotConfirmedError extends Data.TaggedError(
  "WorkerDeleteNotConfirmedError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

/**
 * `delete` could not ask for confirmation and was not told to skip it.
 *
 * There is nowhere to read a typed answer from without an interactive terminal,
 * and the alternative to refusing is deleting on the strength of the command
 * line alone — so a redirected stdout or a CI runner has to pass `--yes`
 * (or `SUPABASE_YES`) to say that out loud.
 */
export class WorkerDeleteConfirmationRequiredError extends Data.TaggedError(
  "WorkerDeleteConfirmationRequiredError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The logs query itself failed. The analytics endpoint can answer HTTP 200 with a populated
 * `error` field, so this isn't reachable from a status code alone; it also covers the server's
 * 30-second query timeout, which arrives as a non-2xx. Kept apart from {@link
 * WorkersApiUnexpectedStatusError} because the SQL here is the CLI's own, not user input — its
 * own fingerprint keeps a broken projection or filter visible instead of blending into transport
 * noise.
 */
export class WorkerLogsQueryFailedError extends Data.TaggedError("WorkerLogsQueryFailedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "query" };
  }
}

/** The project has exhausted its log query allowance (402). */
export class WorkerLogsUsageExceededError extends Data.TaggedError("WorkerLogsUsageExceededError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.planLimit, fingerprint_suffix: "plan_limit" };
  }
}

/**
 * The analytics endpoints allow 10 requests per 60 seconds, which `--follow` polls against — so
 * 429 is an ordinary outcome here, not an edge case. Its own error lets the suggestion name the
 * poll interval as the thing to slow down.
 */
export class WorkerLogsRateLimitedError extends Data.TaggedError("WorkerLogsRateLimitedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "api_status" };
  }
}
