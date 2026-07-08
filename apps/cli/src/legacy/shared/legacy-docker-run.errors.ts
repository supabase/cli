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
   * container runtime could not be executed at all, `pull` when the runtime
   * ran but every registry candidate failed to pull.
   */
  readonly reason: "spawn" | "pull";
  /**
   * For `pull` failures, whether the registry output indicates the daemon
   * itself is unreachable — detected where docker's output is produced, so
   * consumers never sniff `message` text.
   */
  readonly daemonDown: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.reason === "spawn" || this.daemonDown) {
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    }
    return { ...actionability.externalNetwork, fingerprint_suffix: "registry_pull" };
  }
}
