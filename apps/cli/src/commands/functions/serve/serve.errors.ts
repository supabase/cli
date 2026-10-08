import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  unclassifiedStackFailureActionability,
} from "../../../shared/telemetry/error-actionability.ts";

export class FunctionsServeStackError extends Data.TaggedError("FunctionsServeStackError")<{
  readonly reason: "flags" | "invalid-config" | "lifecycle" | "runtime" | "stack";
  readonly message: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return { ...actionability.provideFlags, fingerprint_suffix: "flags" };
      case "invalid-config":
        return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_config" };
      case "lifecycle":
        return (
          causeDeclaration(this.cause) ?? {
            ...actionability.startStack,
            fingerprint_suffix: "lifecycle",
          }
        );
      case "runtime":
        return (
          causeDeclaration(this.cause) ?? {
            ...actionability.runtimeCrash,
            fingerprint_suffix: "runtime_stopped",
          }
        );
      case "stack":
        return causeDeclaration(this.cause) ?? unclassifiedStackFailureActionability;
    }
  }
}
