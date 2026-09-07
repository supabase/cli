import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class LegacyExperimentalStackTargetFlagsError extends Data.TaggedError(
  "LegacyExperimentalStackTargetFlagsError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export class LegacyExperimentalStackStartError extends Data.TaggedError(
  "LegacyExperimentalStackStartError",
)<{
  readonly reason:
    | "invalid-config"
    | "flags"
    | "runtime"
    | "registry"
    | "port"
    | "artifact"
    | "lifecycle"
    | "unknown";
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "invalid-config":
        return actionability.invalidConfig;
      case "flags":
        return actionability.provideFlags;
      case "runtime":
        return actionability.dockerNotRunning;
      case "registry":
      case "artifact":
        return actionability.externalNetwork;
      case "port":
        return actionability.invalidConfig;
      case "lifecycle":
        return actionability.invalidConfig;
      case "unknown":
        return actionability.unknown;
    }
  }
}
