import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

// ---------------------------------------------------------------------------
// HTTP-bound errors — one (Network + UnexpectedStatus) pair per `errors.Errorf`
// call site.
// ---------------------------------------------------------------------------

export class LegacyOrgsListNetworkError extends Data.TaggedError("LegacyOrgsListNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyOrgsListUnexpectedStatusError extends Data.TaggedError(
  "LegacyOrgsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class LegacyOrgsCreateNetworkError extends Data.TaggedError("LegacyOrgsCreateNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class LegacyOrgsCreateUnexpectedStatusError extends Data.TaggedError(
  "LegacyOrgsCreateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

// ---------------------------------------------------------------------------
// Pure-path error — `orgs list --output env` is explicitly rejected. `orgs
// create` does NOT have an equivalent branch — the `EncodeOutput` env
// encoder happily flattens the single object into `ID=… NAME=… SLUG=…`.
// ---------------------------------------------------------------------------

export class LegacyOrgsEnvNotSupportedError extends Data.TaggedError(
  "LegacyOrgsEnvNotSupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
