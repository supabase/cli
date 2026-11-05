import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityFingerprintId,
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

export class FunctionImportNotDirectoryError extends Data.TaggedError(
  "FunctionImportNotDirectoryError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export class FunctionDeployError extends Data.Error<{
  readonly message: string;
  readonly suggestion?: string;
}> {}

export class FunctionImportMapSyntaxError extends Data.Error<{ readonly message: string }> {
  static readonly [ErrorActionabilityFingerprintId] = "FunctionImportMapSyntaxError";
  override readonly name = "SyntaxError";
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Aggregates the per-function failures of a multi-function API deploy. */
export class FunctionsDeployFailedError extends AggregateError {
  static readonly [ErrorActionabilityFingerprintId] = "FunctionsDeployFailedError";
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    const errors: unknown = this.errors;
    if (Array.isArray(errors)) {
      for (const cause of errors) {
        const declaration = causeDeclaration(cause);
        if (declaration !== undefined) return declaration;
      }
    }
    return actionability.unknown;
  }
}
