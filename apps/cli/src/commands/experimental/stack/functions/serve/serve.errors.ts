import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../../shared/telemetry/error-actionability.ts";

export class StackFunctionsServeError extends Data.TaggedError(
  "ExperimentalStackFunctionsServeError",
)<{
  readonly reason: "flags" | "invalid-config" | "lifecycle" | "artifact" | "runtime" | "unknown";
  readonly message: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return actionability.provideFlags;
      case "invalid-config":
      case "lifecycle":
        return actionability.invalidConfig;
      case "artifact":
      case "runtime":
      case "unknown":
        return actionability.unknown;
    }
  }
}
