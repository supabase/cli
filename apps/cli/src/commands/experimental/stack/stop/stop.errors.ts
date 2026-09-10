import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandStopError extends Data.TaggedError("ExperimentalStackStopError")<{
  readonly reason: "flags" | "invalid-config" | "lifecycle" | "unknown";
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
      case "unknown":
        return actionability.unknown;
    }
  }
}
