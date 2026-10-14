import { Data } from "effect";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
  unclassifiedStackFailureActionability,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandStartError extends Data.TaggedError("ExperimentalStackStartError")<{
  readonly reason: "invalid-config" | "flags" | "runtime" | "lifecycle" | "seed" | "stack";
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "invalid-config":
        return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_config" };
      case "flags":
        return { ...actionability.provideFlags, fingerprint_suffix: "flags" };
      case "runtime":
        return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
      case "lifecycle":
        return { ...actionability.invalidConfig, fingerprint_suffix: "lifecycle" };
      case "seed":
        return { ...actionability.seedBuckets, fingerprint_suffix: "seed_buckets" };
      case "stack":
        return causeDeclaration(this.cause) ?? unclassifiedStackFailureActionability;
    }
  }
}
