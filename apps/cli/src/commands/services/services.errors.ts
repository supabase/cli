import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

export class ServicesEnvNotSupportedError extends Data.TaggedError("ServicesEnvNotSupportedError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidInput;
  }
}
