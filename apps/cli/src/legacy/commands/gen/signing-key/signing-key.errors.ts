import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class LegacyGenSigningKeyConfigParseError extends Data.TaggedError(
  "LegacyGenSigningKeyConfigParseError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export class LegacyGenSigningKeyGenerateError extends Data.TaggedError(
  "LegacyGenSigningKeyGenerateError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.internalPanic;
  }
}

export class LegacyGenSigningKeyReadError extends Data.TaggedError("LegacyGenSigningKeyReadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

export class LegacyGenSigningKeyDecodeError extends Data.TaggedError(
  "LegacyGenSigningKeyDecodeError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export class LegacyGenSigningKeyWriteError extends Data.TaggedError(
  "LegacyGenSigningKeyWriteError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

export class LegacyGenSigningKeyCancelledError extends Data.TaggedError(
  "LegacyGenSigningKeyCancelledError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}
