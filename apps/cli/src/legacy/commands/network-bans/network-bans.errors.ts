import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

export class LegacyNetworkBansGetNetworkError extends Data.TaggedError(
  "LegacyNetworkBansGetNetworkError",
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

export class LegacyNetworkBansGetUnexpectedStatusError extends Data.TaggedError(
  "LegacyNetworkBansGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class LegacyNetworkBansRemoveNetworkError extends Data.TaggedError(
  "LegacyNetworkBansRemoveNetworkError",
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

export class LegacyNetworkBansRemoveUnexpectedStatusError extends Data.TaggedError(
  "LegacyNetworkBansRemoveUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class LegacyNetworkBansEnvNotSupportedError extends Data.TaggedError(
  "LegacyNetworkBansEnvNotSupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class LegacyNetworkBansInvalidIpError extends Data.TaggedError(
  "LegacyNetworkBansInvalidIpError",
)<{
  readonly input: string;
  readonly message: string;
}> {
  constructor(args: { readonly input: string }) {
    super({ input: args.input, message: `invalid IP address: ${args.input}` });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
