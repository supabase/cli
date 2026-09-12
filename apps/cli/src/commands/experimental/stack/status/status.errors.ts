import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandStatusError extends Data.TaggedError("ExperimentalStackStatusError")<{
  readonly message: string;
  readonly reason: "flags" | "not-found" | "invalid-config" | "lifecycle" | "output" | "runtime";
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
      case "not-found":
        return actionability.provideFlags;
      case "invalid-config":
        return actionability.invalidConfig;
      case "lifecycle":
        return actionability.startStack;
      case "output":
        return actionability.provideFlags;
      case "runtime":
        return actionability.unknown;
    }
  }
}
