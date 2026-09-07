import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class LegacyExperimentalStackLogsError extends Data.TaggedError(
  "LegacyExperimentalStackLogsError",
)<{
  readonly reason: "flags" | "invalid-config" | "lifecycle" | "impossible-state" | "unknown";
  readonly message: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return actionability.provideFlags;
      case "invalid-config":
        return actionability.invalidConfig;
      case "lifecycle":
        return actionability.invalidConfig;
      case "impossible-state":
        return actionability.impossibleState;
      case "unknown":
        return actionability.unknown;
    }
  }
}
