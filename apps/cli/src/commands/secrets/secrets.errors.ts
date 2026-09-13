import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

export class SecretsListNetworkError extends Data.TaggedError("SecretsListNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class SecretsListUnexpectedStatusError extends Data.TaggedError(
  "SecretsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class SecretsSetNetworkError extends Data.TaggedError("SecretsSetNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class SecretsSetUnexpectedStatusError extends Data.TaggedError(
  "SecretsSetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class SecretsUnsetNetworkError extends Data.TaggedError("SecretsUnsetNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

export class SecretsUnsetUnexpectedStatusError extends Data.TaggedError(
  "SecretsUnsetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

export class SecretsEnvFileOpenError extends Data.TaggedError("SecretsEnvFileOpenError")<{
  readonly message: string;
  readonly reason: "not_found" | "permission" | "other";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.reason === "not_found") {
      return { ...actionability.provideFlags, fingerprint_suffix: "not_found" };
    }
    if (this.reason === "permission") {
      return { ...actionability.permission, fingerprint_suffix: "filesystem" };
    }
    return { ...actionability.unknown, fingerprint_suffix: "platform_error" };
  }
}

export class SecretsEnvFileParseError extends Data.TaggedError("SecretsEnvFileParseError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class SecretsSetInputError extends Data.TaggedError("SecretsSetInputError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class InvalidSecretPairError extends Data.TaggedError("InvalidSecretPairError")<{
  readonly pair: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class SecretsNoArgumentsError extends Data.TaggedError("SecretsNoArgumentsError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class SecretsEnvNotSupportedError extends Data.TaggedError("SecretsEnvNotSupportedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class SecretsUnsetCancelledError extends Data.TaggedError("SecretsUnsetCancelledError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}
