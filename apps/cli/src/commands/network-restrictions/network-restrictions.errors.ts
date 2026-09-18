import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

export class NetworkRestrictionsGetNetworkError extends Data.TaggedError(
  "NetworkRestrictionsGetNetworkError",
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

export class NetworkRestrictionsGetUnexpectedStatusError extends Data.TaggedError(
  "NetworkRestrictionsGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class NetworkRestrictionsUpdateNetworkError extends Data.TaggedError(
  "NetworkRestrictionsUpdateNetworkError",
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

export class NetworkRestrictionsUpdateUnexpectedStatusError extends Data.TaggedError(
  "NetworkRestrictionsUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class NetworkRestrictionsInvalidCidrError extends Data.TaggedError(
  "NetworkRestrictionsInvalidCidrError",
)<{
  readonly input: string;
  readonly message: string;
}> {
  constructor(args: { readonly input: string }) {
    super({ input: args.input, message: `failed to parse IP: ${args.input}` });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class NetworkRestrictionsPrivateIpError extends Data.TaggedError(
  "NetworkRestrictionsPrivateIpError",
)<{
  readonly input: string;
  readonly message: string;
}> {
  constructor(args: { readonly input: string }) {
    super({ input: args.input, message: `private IP provided: ${args.input}` });
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
