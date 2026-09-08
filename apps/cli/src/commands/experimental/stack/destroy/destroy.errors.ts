import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class LegacyExperimentalStackDestroyError extends Data.TaggedError(
  "LegacyExperimentalStackDestroyError",
)<{
  readonly reason: "flags" | "confirmation" | "invalid-config" | "lifecycle" | "unknown";
  readonly message: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
      case "confirmation":
        return actionability.provideFlags;
      case "invalid-config":
      case "lifecycle":
        return actionability.invalidConfig;
      case "unknown":
        return actionability.unknown;
    }
    return actionability.unknown;
  }
}
