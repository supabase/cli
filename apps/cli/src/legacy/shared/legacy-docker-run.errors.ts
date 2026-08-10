import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/** Spawning or running the `docker` CLI failed (binary missing, daemon down, non-spawn failure). */
export class LegacyDockerRunError extends Data.TaggedError("LegacyDockerRunError")<{
  readonly message: string;
  /**
   * Structured discriminant set at the docker boundary: `spawn` when the
   * container runtime could not be executed, `inspect` when image inspection
   * failed, and `pull` when every registry candidate failed.
   */
  readonly reason: "spawn" | "inspect" | "pull";
  /**
   * Whether runtime output indicates the daemon itself is unreachable,
   * detected where docker's output is produced so consumers never inspect
   * `message` text.
   */
  readonly daemonDown: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.reason === "spawn" || this.daemonDown) {
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    }
    return this.reason === "pull"
      ? { ...actionability.externalNetwork, fingerprint_suffix: "registry_pull" }
      : { ...actionability.invalidConfig, fingerprint_suffix: "image_inspect" };
  }
}
