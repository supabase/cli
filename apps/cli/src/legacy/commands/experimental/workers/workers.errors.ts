import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

/**
 * `--output env` cannot represent a payload containing a list.
 *
 * `encodeEnv` reproduces `godotenv.Marshal`, whose flattening does not descend
 * into slices — a `workers` array would land as a single `WORKERS=""` line
 * rather than one entry per worker. Refusing is the same call `functions list`
 * makes for the same reason, rather than emitting output that silently omits
 * the data.
 */
export class LegacyWorkersEnvNotSupportedError extends Data.TaggedError(
  "LegacyWorkersEnvNotSupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
