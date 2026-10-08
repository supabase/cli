import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  unclassifiedStackFailureActionability,
} from "../../../shared/telemetry/error-actionability.ts";

/** Keeps a cause's own classification, falling back to this reason's suffix when it has none. */
const withSuffix = (
  declared: CliErrorActionabilityDeclaration | undefined,
  fallback: CliErrorActionabilityDeclaration,
  suffix: "lifecycle" | "runtime_stopped",
): CliErrorActionabilityDeclaration =>
  declared === undefined
    ? { ...fallback, fingerprint_suffix: suffix }
    : { ...declared, fingerprint_suffix: declared.fingerprint_suffix ?? suffix };

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
        return withSuffix(causeDeclaration(this.cause), actionability.startStack, "lifecycle");
      case "runtime":
        return withSuffix(
          causeDeclaration(this.cause),
          actionability.runtimeCrash,
          "runtime_stopped",
        );
      case "stack":
        return causeDeclaration(this.cause) ?? unclassifiedStackFailureActionability;
    }
  }
}
