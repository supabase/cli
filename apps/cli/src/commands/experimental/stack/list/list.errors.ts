import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class LegacyExperimentalStackListError extends Data.TaggedError(
  "LegacyExperimentalStackListError",
)<{
  readonly message: string;
  readonly reason: "flags" | "invalid-config" | "runtime";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.reason === "flags") return actionability.provideFlags;
    return this.reason === "runtime" ? actionability.externalNetwork : actionability.invalidConfig;
  }
}
