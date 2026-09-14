import { Data } from "effect";
import { SUGGEST_DOCKER_INSTALL } from "../../command-internal/docker-suggest.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

// Exit codes for termination requested by a supervisor, not a self-raised crash signal;
// 137 is excluded because streamContainerLogs retries it separately.
const externalTerminationExitCodes = new Set([
  129, // SIGHUP
  130, // SIGINT
  131, // SIGQUIT
  143, // SIGTERM
]);

/**
 * The edge runtime container exited with a non-zero, non-`137` code while
 * streaming logs. An `externalTerminationExitCodes` code means a supervisor tore
 * the container down (not a Supabase bug); any other code means it crashed on its own.
 */
export class EdgeRuntimeContainerCrashedError extends Data.TaggedError(
  "EdgeRuntimeContainerCrashedError",
)<{
  readonly message: string;
  readonly containerId: string;
  readonly exitCode: number;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (externalTerminationExitCodes.has(this.exitCode)) {
      return { ...actionability.cancelled, fingerprint_suffix: "cancelled" };
    }
    return actionability.runtimeCrash;
  }
}

/**
 * The `docker logs -f` process feeding `functions serve` output exited with
 * an error `isRetriableDockerLogsError` does not recognize as transient.
 */
export class DockerLogsStreamError extends Data.TaggedError("DockerLogsStreamError")<{
  readonly message: string;
  readonly containerId: string;
  readonly exitCode: number;
  readonly stderr: string;
  /**
   * Whether the stream died because the container daemon itself is
   * unreachable, decided where docker's output is produced so consumers never
   * inspect `message` text.
   */
  readonly daemonDown: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.daemonDown) {
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    }
    return actionability.unknown;
  }

  /** Keeps the user-visible remediation in sync with the `dockerNotRunning` actionability above. */
  get suggestion(): string | undefined {
    return this.daemonDown ? SUGGEST_DOCKER_INSTALL : undefined;
  }
}
