import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  unclassifiedStackFailureActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandStatusError extends Data.TaggedError("ExperimentalStackStatusError")<{
  readonly message: string;
  readonly reason: "flags" | "not-found" | "invalid-config" | "lifecycle" | "output" | "stack";
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return { ...actionability.provideFlags, fingerprint_suffix: "flags" };
      case "not-found":
        return { ...actionability.provideFlags, fingerprint_suffix: "not_found" };
      case "invalid-config":
        return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_config" };
      case "lifecycle":
        return { ...actionability.startStack, fingerprint_suffix: "lifecycle" };
      case "output":
        return { ...actionability.provideFlags, fingerprint_suffix: "output_format" };
      case "stack":
        return causeDeclaration(this.cause) ?? unclassifiedStackFailureActionability;
    }
  }
}
