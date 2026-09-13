import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../telemetry/error-actionability.ts";

/**
 * Every compute failure carries a `detail` saying what happened and a
 * `suggestion` naming the command that fixes it. The shared output layer renders
 * the pair, so no command formats its own recovery line.
 */

export class InvalidComputeNameError extends Data.TaggedError("InvalidComputeNameError")<{
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
export class MissingComputeNameError extends Data.TaggedError("MissingComputeNameError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * A symlink in the compute source points outside the build context.
 *
 * The archive is everything the server gets, with no install step and no view of the surrounding
 * repository, so a link whose target isn't also packaged arrives dangling — the catalog runtimes
 * boot without the dependency, or a Dockerfile build fails on `COPY`, both minutes later with
 * nothing naming the cause. Refused here instead. The common source is a package manager that
 * hoists dependencies to the repository root, outside the compute's own `node_modules`.
 */
export class ComputeSourceEscapingLinkError extends Data.TaggedError(
  "ComputeSourceEscapingLinkError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** A bare `push` found no compute to deploy — none named, none in the project. */
export class NoComputeToDeployError extends Data.TaggedError("NoComputeToDeployError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `config.toml` records a runtime this CLI does not offer. Raised by `push`, which reads a
 * compute's runtime back out of config; `new` writes one but never reads it.
 */
export class UnknownComputeRuntimeError extends Data.TaggedError("UnknownComputeRuntimeError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** As {@link UnknownComputeRuntimeError}, for a recorded instance size. */
export class UnknownComputeSizeError extends Data.TaggedError("UnknownComputeSizeError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class UnknownComputeExposureError extends Data.TaggedError("UnknownComputeExposureError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class MissingComputeExposureError extends Data.TaggedError("MissingComputeExposureError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class ComputeDirectoryExistsError extends Data.TaggedError("ComputeDirectoryExistsError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** A compute scaffold cannot safely edit a JSON-authoritative project config. */
export class ComputeJsonConfigUnsupportedError extends Data.TaggedError(
  "ComputeJsonConfigUnsupportedError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export class ComputeSourceMissingError extends Data.TaggedError("ComputeSourceMissingError")<{
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
export class InvalidComputeSourceError extends Data.TaggedError("InvalidComputeSourceError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** The deploy finished, and the build it started failed. */
export class ComputeBuildFailedError extends Data.TaggedError("ComputeBuildFailedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/** The build never left `building` inside the CLI's polling budget. */
export class ComputeBuildTimeoutError extends Data.TaggedError("ComputeBuildTimeoutError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.apiStatus;
  }
}

/** PUTting the build context to the presigned slot failed. */
export class ComputeUploadFailedError extends Data.TaggedError("ComputeUploadFailedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/** Transport failure talking to the Management API. */
export class ComputeApiNetworkError extends Data.TaggedError("ComputeApiNetworkError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/**
 * The named compute is not deployed. `status`/`delete` share this verbatim: the
 * question "does this exist?" is asked of the API, never of a local directory.
 */
export class ComputeNotDeployedError extends Data.TaggedError("ComputeNotDeployedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * Compute are in private alpha: an unenrolled project's routes answer 404, indistinguishable at
 * the transport level from an unknown compute — so this is only raised on collection endpoints,
 * where there's no compute name that could have been wrong.
 */
export class ComputeUnavailableError extends Data.TaggedError("ComputeUnavailableError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

/**
 * The project ref names no project this account can see. Separated from {@link
 * ComputeUnavailableError} because both arrive as a 404 on the same routes, and suggesting alpha
 * enrolment for a project that doesn't exist would send someone somewhere that can't help.
 */
export class ComputeProjectNotFoundError extends Data.TaggedError("ComputeProjectNotFoundError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Any other status the Compute routes answered with. Classified from the status it carries rather
 * than bucketed as a generic service failure — a 401 is the user's to fix by logging in, a 403 by
 * getting access, and reporting either as `api_status` would blur the actionability signal.
 */
export class ComputeApiUnexpectedStatusError extends Data.TaggedError(
  "ComputeApiUnexpectedStatusError",
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
export class ComputeDeleteNotConfirmedError extends Data.TaggedError(
  "ComputeDeleteNotConfirmedError",
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
export class ComputeDeleteConfirmationRequiredError extends Data.TaggedError(
  "ComputeDeleteConfirmationRequiredError",
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
 * ComputeApiUnexpectedStatusError} because the SQL here is the CLI's own, not user input — its
 * own fingerprint keeps a broken projection or filter visible instead of blending into transport
 * noise.
 */
export class ComputeLogsQueryFailedError extends Data.TaggedError("ComputeLogsQueryFailedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "query" };
  }
}

/** The project has exhausted its log query allowance (402). */
export class ComputeLogsUsageExceededError extends Data.TaggedError(
  "ComputeLogsUsageExceededError",
)<{
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
export class ComputeLogsRateLimitedError extends Data.TaggedError("ComputeLogsRateLimitedError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "api_status" };
  }
}
