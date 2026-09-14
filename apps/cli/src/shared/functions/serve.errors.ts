import { Data } from "effect";
import {
  SUGGEST_DOCKER_INSTALL,
  SUGGEST_DOCKER_START,
} from "../../command-internal/docker-suggest.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/**
 * The edge runtime container exited with a real crash signal or other non-zero code while
 * streaming logs. Supervisor-initiated shutdowns (SIGHUP/SIGINT/SIGQUIT/SIGTERM) end the
 * `functions serve` session successfully instead of reaching this error; 137 (SIGKILL) is
 * retried by `streamContainerLogs` rather than failing.
 */
export class EdgeRuntimeContainerCrashedError extends Data.TaggedError(
  "EdgeRuntimeContainerCrashedError",
)<{
  readonly message: string;
  readonly containerId: string;
  readonly exitCode: number;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.runtimeCrash;
  }
}

/**
 * The `docker logs -f` process feeding `functions serve` output exited with an error that a
 * follow-up `docker container inspect` didn't resolve into an end-of-session or re-attach case.
 */
export class DockerLogsStreamError extends Data.TaggedError("DockerLogsStreamError")<{
  readonly message: string;
  readonly containerId: string;
  readonly exitCode: number;
  readonly stderr: string;
  /**
   * Whether the stream died because the container daemon itself is unreachable, decided from the
   * follow-up inspect's own failure so consumers never inspect `stderr`/`message` text.
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
    return this.daemonDown ? SUGGEST_DOCKER_START : undefined;
  }
}

/**
 * `streamContainerLogs` re-attached to `docker logs -f` the configured consecutive-cap number of
 * times without forwarding a new line, while the container kept running — a daemon that keeps
 * closing the stream rather than a Supabase bug.
 */
export class EdgeRuntimeLogStreamLostError extends Data.TaggedError(
  "EdgeRuntimeLogStreamLostError",
)<{
  readonly message: string;
  readonly containerId: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.externalNetwork;
  }
}

/** `assertLocalDbRunning`'s DB container inspect found no such container: `supabase start` hasn't run. */
export class ServeLocalDbNotRunningError extends Data.TaggedError("ServeLocalDbNotRunningError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/**
 * `assertLocalDbRunning`'s DB container inspect failed for a reason other than the container
 * missing. `daemonDown` narrows the unreachable-daemon/missing-binary case (from
 * {@link isDockerDaemonUnreachable}) to the dedicated actionable bucket; any other inspect
 * failure keeps a tagged identity of its own instead of the generic bare-`Error` fingerprint.
 */
export class ServeLocalDbInspectError extends Data.TaggedError("ServeLocalDbInspectError")<{
  readonly message: string;
  readonly daemonDown: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.daemonDown) {
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    }
    return actionability.unknown;
  }

  /**
   * Unlike {@link DockerLogsStreamError}'s daemon-down suggestion, this is a pre-flight check a
   * genuinely missing Docker binary can reach, so the install hint is the correct remediation.
   */
  get suggestion(): string | undefined {
    return this.daemonDown ? SUGGEST_DOCKER_INSTALL : undefined;
  }
}
