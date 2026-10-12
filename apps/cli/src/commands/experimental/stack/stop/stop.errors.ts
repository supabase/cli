import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  unclassifiedStackFailureActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandStopError extends Data.TaggedError("ExperimentalStackStopError")<{
  readonly reason: "flags" | "invalid-config" | "stack";
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return { ...actionability.provideFlags, fingerprint_suffix: "flags" };
      case "invalid-config":
        return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_config" };
      case "stack":
        return causeDeclaration(this.cause) ?? unclassifiedStackFailureActionability;
    }
  }
}
