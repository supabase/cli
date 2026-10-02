import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandDestroyError extends Data.TaggedError("ExperimentalStackDestroyError")<{
  readonly reason:
    | "flags"
    | "confirmation"
    | "cancelled"
    | "invalid-config"
    | "runtime"
    | "lifecycle"
    | "unknown";
  readonly message: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
      case "confirmation":
        return actionability.provideFlags;
      case "cancelled":
        return actionability.cancelled;
      case "invalid-config":
      case "lifecycle":
        return actionability.invalidConfig;
      case "runtime":
        return actionability.dockerNotRunning;
      case "unknown":
        return actionability.unknown;
    }
  }
}
