import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

export class InvalidFunctionSlugError extends Data.TaggedError("InvalidFunctionSlugError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class ConflictingFunctionDownloadFlagsError extends Data.TaggedError(
  "ConflictingFunctionDownloadFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class FunctionDownloadNotFoundError extends Data.TaggedError(
  "FunctionDownloadNotFoundError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class InvalidFunctionDownloadResponseError extends Data.TaggedError(
  "InvalidFunctionDownloadResponseError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // Every construction is a 200-response whose multipart/metadata/list body
    // failed to decode — an API response problem, not a raw status failure.
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

export class UnsafeFunctionDownloadPathError extends Data.TaggedError(
  "UnsafeFunctionDownloadPathError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}
