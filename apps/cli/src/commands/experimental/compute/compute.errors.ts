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

/**
 * `--follow` cannot be combined with an output format that promises exactly
 * one terminal payload (`-o json|yaml|toml`, `--output-format json`) — an
 * unbounded tail has no last element to put in it. Refused up front so a
 * query isn't paid for only to fail on the first emission. `--output-format
 * stream-json` is unaffected.
 */
export class ComputeFollowNotSupportedError extends Data.TaggedError(
  "ComputeFollowNotSupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
