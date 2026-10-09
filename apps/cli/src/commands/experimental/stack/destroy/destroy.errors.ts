import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  unclassifiedStackFailureActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandDestroyError extends Data.TaggedError("ExperimentalStackDestroyError")<{
  readonly reason: "flags" | "confirmation" | "cancelled" | "invalid-config" | "runtime" | "stack";
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
        return { ...actionability.provideFlags, fingerprint_suffix: "flags" };
      case "confirmation":
        return { ...actionability.provideFlags, fingerprint_suffix: "confirmation" };
      case "cancelled":
        return { ...actionability.cancelled, fingerprint_suffix: "cancelled" };
      case "invalid-config":
        return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_config" };
      case "runtime":
        return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
      case "stack":
        return causeDeclaration(this.cause) ?? unclassifiedStackFailureActionability;
    }
  }
}
