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
 * A bare `new` had no name to scaffold under, and nowhere to ask for one.
 *
 * The name is the one input this command cannot default — it is the directory,
 * the `config.toml` key and the hostname all at once — so with `-o` in force or
 * no interactive terminal there is nothing to do but say so.
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
 * The archive is everything the server gets — it runs no install step and has
 * no view of the surrounding repository — so a link whose target is not also
 * packaged arrives dangling. The catalog runtimes then boot without the
 * dependency and a Dockerfile build fails on the `COPY`, both of them minutes
 * later and with nothing naming the cause. Refused here instead.
 *
 * The common source is a package manager that hoists: a worker directory that
 * is a pnpm workspace member links its dependencies at the repository root
 * rather than under its own `node_modules`.
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
 * `config.toml` records a runtime this CLI does not offer.
 *
 * Raised by `push`, the command that reads a worker's runtime back out of
 * config; `new` writes one and never reads it.
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
 * `--source` names a directory it is not allowed to name. Worth its own error
 * because the destination is where the starter files land, so a value that
 * resolves to the project root, `supabase/`, or anywhere outside the project has
 * to be refused before anything is written.
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

/**
 * The project ref names no project this account can see.
 *
 * Separated from {@link WorkersUnavailableError} because both arrive as a 404
 * on the same routes, and telling someone to request alpha enrolment for a
 * project that does not exist sends them somewhere that cannot help.
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
 * Any other status the Workers routes answered with.
 *
 * Classified from the status it carries rather than bucketed as a service
 * failure: a 401 is the user's to fix by logging in and a 403 by getting access,
 * and reporting either as `api_status` both misleads the user and blurs the
 * actionability signal for every Workers endpoint at once.
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
 * The logs query itself failed.
 *
 * The analytics endpoint can answer **HTTP 200** with a populated `error` field,
 * so this is not reachable from a status code alone. It also covers the server's
 * 30-second query timeout, which arrives as a non-2xx.
 *
 * Classified apart from {@link WorkersApiUnexpectedStatusError} on purpose: the
 * SQL is this CLI's, not the user's input, so a rejected query means a projection
 * or a filter here is wrong. Its own fingerprint keeps that visible in telemetry
 * instead of grouped with transport noise from every other Workers route.
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
 * The analytics endpoints allow 10 requests per 60 seconds, which `--follow`
 * polls against — so 429 is an ordinary outcome here rather than an edge case,
 * and it gets its own error so the suggestion can name the poll interval as the
 * thing to slow down.
 */
export class WorkerLogsRateLimitedError extends Data.TaggedError("WorkerLogsRateLimitedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "api_status" };
  }
}
