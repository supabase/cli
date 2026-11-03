import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * `--output env` cannot represent a payload containing a list.
 *
 * `encodeEnv`'s flattening does not descend into slices, so a `compute` array
 * would land as a single empty `COMPUTE=""` line instead of one entry per compute.
 */
export class ComputeEnvNotSupportedError extends Data.TaggedError("ComputeEnvNotSupportedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
