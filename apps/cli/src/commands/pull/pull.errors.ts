import { Data } from "effect";
import {
  actionability,
  ErrorActionabilityId,
  type CliErrorActionabilityDeclaration,
} from "../../shared/telemetry/error-actionability.ts";

export class PullOutputFlagUnsupportedError extends Data.TaggedError(
  "PullOutputFlagUnsupportedError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class PullSecretNameError extends Data.TaggedError("PullSecretNameError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
