import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

export class LegacyExperimentalStackRestartError extends Data.TaggedError(
  "LegacyExperimentalStackRestartError",
)<{
  readonly message: string;
  readonly reason:
    | "flags"
    | "not-found"
    | "invalid-config"
    | "lifecycle"
    | "docker"
    | "registry"
    | "artifact"
    | "runtime";
  readonly suggestion?: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.reason === "flags" || this.reason === "not-found") return actionability.provideFlags;
    if (this.reason === "invalid-config" || this.reason === "lifecycle")
      return actionability.invalidConfig;
    if (this.reason === "docker") return actionability.dockerNotRunning;
    return actionability.externalNetwork;
  }
}
