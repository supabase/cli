import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

export class SslEnforcementGetNetworkError extends Data.TaggedError(
  "SslEnforcementGetNetworkError",
)<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class SslEnforcementGetUnexpectedStatusError extends Data.TaggedError(
  "SslEnforcementGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class SslEnforcementUpdateNetworkError extends Data.TaggedError(
  "SslEnforcementUpdateNetworkError",
)<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class SslEnforcementUpdateUnexpectedStatusError extends Data.TaggedError(
  "SslEnforcementUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class SslEnforcementNoEnableDisableFlagError extends Data.TaggedError(
  "SslEnforcementNoEnableDisableFlagError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "enable/disable not specified" });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// Verbatim cobra string for `MarkFlagsMutuallyExclusive`. Effect CLI has no
// built-in equivalent, so we enforce it at handler entry.
export class SslEnforcementMutuallyExclusiveFlagsError extends Data.TaggedError(
  "SslEnforcementMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  constructor() {
    super({
      message:
        "if any flags in the group [enable-db-ssl-enforcement disable-db-ssl-enforcement] are set none of the others can be",
    });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
