import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * `--output env` cannot represent a payload containing a list.
 *
 * `encodeEnv` reproduces `godotenv.Marshal`, whose flattening does not descend
 * into slices — a `compute` array would land as a single `COMPUTE=""` line
 * rather than one entry per compute. Refusing is the same call `functions list`
 * makes for the same reason, rather than emitting output that silently omits
 * the data.
 */
export class ComputeEnvNotSupportedError extends Data.TaggedError("ComputeEnvNotSupportedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}

/**
 * `--follow` was asked for alongside an output format that cannot express a
 * stream.
 *
 * `-o json|yaml|toml` and `--output-format json` each promise exactly one
 * terminal payload, and an unbounded tail has no last element to put in it.
 * Refused up front rather than at the first emission, for the same reason
 * {@link ComputeEnvNotSupportedError} is: discovering it later means
 * failing after the first query has been paid for.
 *
 * `--output-format stream-json` is the streaming machine format and is allowed.
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
