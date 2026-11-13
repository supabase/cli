import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  CliErrorKind,
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

export class FunctionDeployDockerNotRunningError extends Data.TaggedError(
  "FunctionDeployDockerNotRunningError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
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

const causeKindSeverity = {
  [CliErrorKind.InternalBug]: 4,
  [CliErrorKind.Unknown]: 3,
  [CliErrorKind.ExternalService]: 2,
  [CliErrorKind.UserActionable]: 1,
  [CliErrorKind.UserCancelled]: 0,
} as const satisfies Record<CliErrorKind, number>;

/** Aggregates the per-function failures of a multi-function API deploy. */
export class FunctionsDeployFailedError extends AggregateError {
  static readonly [ErrorActionabilityFingerprintId] = "FunctionsDeployFailedError";
  /** Reports the most severe cause, so a CLI or upstream failure is never masked by a user error. */
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    const errors: unknown = this.errors;
    let worst: CliErrorActionabilityDeclaration | undefined;
    if (Array.isArray(errors)) {
      for (const cause of errors) {
        const declaration = causeDeclaration(cause) ?? actionability.unknown;
        if (
          worst === undefined ||
          causeKindSeverity[declaration.error_kind] > causeKindSeverity[worst.error_kind]
        ) {
          worst = declaration;
        }
      }
    }
    return worst ?? actionability.unknown;
  }
}
