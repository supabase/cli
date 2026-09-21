import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class StackCommandRestartError extends Data.TaggedError("ExperimentalStackRestartError")<{
  readonly reason:
    | "flags"
    | "not-found"
    | "invalid-config"
    | "port"
    | "lifecycle"
    | "runtime"
    | "registry"
    | "artifact"
    | "unknown";
  readonly message: string;
  readonly detail?: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "flags":
      case "not-found":
        return actionability.provideFlags;
      case "invalid-config":
      case "port":
      case "lifecycle":
        return actionability.invalidConfig;
      case "runtime":
        return actionability.dockerNotRunning;
      case "registry":
      case "artifact":
        return actionability.externalNetwork;
      case "unknown":
        return actionability.unknown;
    }
  }
}
