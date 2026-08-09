import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

export class BranchNotFoundError extends Data.TaggedError("BranchNotFoundError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class NoBranchNameError extends Data.TaggedError("NoBranchNameError")<{
  readonly detail: string;
  readonly suggestion: string;
  /**
   * Set when the user declined the "create branch named …?" prompt: the
   * failure is a deliberate cancellation, not missing input. Left unset for
   * the genuine "no name and no way to obtain one" paths, which stay
   * `provideFlags`.
   */
  readonly cancelled?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.cancelled === true
      ? { ...actionability.cancelled, fingerprint_suffix: "cancelled" }
      : actionability.provideFlags;
  }
}

export class BranchAlreadyExistsError extends Data.TaggedError("BranchAlreadyExistsError")<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
