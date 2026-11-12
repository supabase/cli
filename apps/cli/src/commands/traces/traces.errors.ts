import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

/** `--trace-id` is required until trace search exists; this gives a clearer message than a parser error. */
export class TracesMissingTraceIdError extends Data.TaggedError("TracesMissingTraceIdError")<{
  readonly message: string;
}> {
  constructor() {
    super({
      message:
        "Trace search isn't available yet. Pass --trace-id <id> to look up a specific trace.",
    });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class TracesNetworkError extends Data.TaggedError("TracesNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class TracesUnexpectedStatusError extends Data.TaggedError("TracesUnexpectedStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/** The endpoint returns a 200 with an empty span list rather than a 404 when nothing matches. */
export class TracesNotFoundError extends Data.TaggedError("TracesNotFoundError")<{
  readonly message: string;
}> {
  constructor() {
    super({
      message:
        "No spans found for that trace. It may be outside retention, sampled out, never ingested, or in a different project.",
    });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.invalidInput, fingerprint_suffix: "not_found" };
  }
}

export class TracesOutputFlagUnsupportedError extends Data.TaggedError(
  "TracesOutputFlagUnsupportedError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
