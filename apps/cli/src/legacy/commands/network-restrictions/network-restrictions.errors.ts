import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

export class LegacyNetworkRestrictionsGetNetworkError extends Data.TaggedError(
  "LegacyNetworkRestrictionsGetNetworkError",
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

export class LegacyNetworkRestrictionsGetUnexpectedStatusError extends Data.TaggedError(
  "LegacyNetworkRestrictionsGetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class LegacyNetworkRestrictionsUpdateNetworkError extends Data.TaggedError(
  "LegacyNetworkRestrictionsUpdateNetworkError",
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

export class LegacyNetworkRestrictionsUpdateUnexpectedStatusError extends Data.TaggedError(
  "LegacyNetworkRestrictionsUpdateUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class LegacyNetworkRestrictionsInvalidCidrError extends Data.TaggedError(
  "LegacyNetworkRestrictionsInvalidCidrError",
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

export class LegacyNetworkRestrictionsPrivateIpError extends Data.TaggedError(
  "LegacyNetworkRestrictionsPrivateIpError",
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
