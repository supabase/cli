import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../../shared/telemetry/error-actionability.ts";

// ---------------------------------------------------------------------------
// HTTP-bound errors (network + unexpected-status pairs)
// ---------------------------------------------------------------------------

export class LegacySecretsListNetworkError extends Data.TaggedError(
  "LegacySecretsListNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class LegacySecretsListUnexpectedStatusError extends Data.TaggedError(
  "LegacySecretsListUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class LegacySecretsSetNetworkError extends Data.TaggedError("LegacySecretsSetNetworkError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class LegacySecretsSetUnexpectedStatusError extends Data.TaggedError(
  "LegacySecretsSetUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status);
  }
}

export class LegacySecretsUnsetNetworkError extends Data.TaggedError(
  "LegacySecretsUnsetNetworkError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

export class LegacySecretsUnsetUnexpectedStatusError extends Data.TaggedError(
  "LegacySecretsUnsetUnexpectedStatusError",
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
// Pure-path errors (validation, file I/O, user cancellation)
// ---------------------------------------------------------------------------

export class LegacySecretsEnvFileOpenError extends Data.TaggedError(
  "LegacySecretsEnvFileOpenError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacySecretsEnvFileParseError extends Data.TaggedError(
  "LegacySecretsEnvFileParseError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class LegacyInvalidSecretPairError extends Data.TaggedError("LegacyInvalidSecretPairError")<{
  readonly pair: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class LegacySecretsNoArgumentsError extends Data.TaggedError(
  "LegacySecretsNoArgumentsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacySecretsEnvNotSupportedError extends Data.TaggedError(
  "LegacySecretsEnvNotSupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

export class LegacySecretsUnsetCancelledError extends Data.TaggedError(
  "LegacySecretsUnsetCancelledError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}
