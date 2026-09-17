import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

export class ConflictingFunctionDeployFlagsError extends Data.TaggedError(
  "ConflictingFunctionDeployFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class InvalidFunctionDeploySlugError extends Data.TaggedError(
  "InvalidFunctionDeploySlugError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class NoFunctionsToDeployError extends Data.TaggedError("NoFunctionsToDeployError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class FunctionDeployCancelledError extends Data.TaggedError("FunctionDeployCancelledError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.cancelled;
  }
}

export class FunctionImportNotDirectoryError extends Data.TaggedError(
  "FunctionImportNotDirectoryError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export class FunctionDeployError extends Data.TaggedError("FunctionDeployError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.unknown;
  }
}
