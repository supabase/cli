import { Data } from "effect";
import {
  SUGGEST_CONTAINER_MEMORY_LIMIT,
  SUGGEST_DOCKER_INSTALL,
  SUGGEST_DOCKER_START,
  SUGGEST_DOCKER_START_RERUN,
  isDockerDaemonUnreachable,
} from "../../command-internal/docker-suggest.ts";
import {
  actionability,
  causeDeclaration,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../telemetry/error-actionability.ts";

/**
 * Exit codes a supervisor uses to tear a container down (`supabase stop`, CI cancellation), not a
 * self-raised crash signal; 137 is excluded because it needs `OOMKilled` to tell a memory-limit
 * kill from a kill the CLI cannot attribute.
 */
export const externalTerminationExitCodes: ReadonlySet<number> = new Set([
  15, // SIGTERM as edge-runtime reports it: the raw signal number, not 128 + 15
  129, // SIGHUP
  130, // SIGINT
  131, // SIGQUIT
  143, // SIGTERM
]);

/**
 * The edge runtime container exited with a real crash signal or other non-zero code while
 * streaming logs. Supervisor-initiated shutdowns (SIGHUP/SIGINT/SIGQUIT/SIGTERM) end the
 * `functions serve` session successfully instead of reaching this error. `oomKilled` means the
 * container hit its memory limit; a `137` without it was killed from outside the CLI, which we
 * cannot attribute to either side.
 */
export class EdgeRuntimeContainerCrashedError extends Data.TaggedError(
  "EdgeRuntimeContainerCrashedError",
)<{
  readonly message: string;
  readonly containerId: string;
  readonly exitCode: number;
  readonly oomKilled: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.oomKilled) {
      return { ...actionability.resourceLimit, fingerprint_suffix: "out_of_memory" };
    }
    if (this.exitCode === 137) {
      return { ...actionability.unknown, fingerprint_suffix: "container_killed" };
    }
    return actionability.runtimeCrash;
  }

  /** Only an out-of-memory kill has a known remediation; other kills don't. */
  get suggestion(): string | undefined {
    return this.oomKilled ? SUGGEST_CONTAINER_MEMORY_LIMIT : undefined;
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
  /**
   * Whether the follow-up inspect found the container killed for exceeding its memory limit.
   * False when that inspect failed and there is no container state to read.
   */
  readonly oomKilled: boolean;
  /** The stopped container's exit code from the follow-up inspect, absent when that inspect failed. */
  readonly containerExitCode?: number;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    if (this.oomKilled) {
      return { ...actionability.resourceLimit, fingerprint_suffix: "out_of_memory" };
    }
    if (this.daemonDown) {
      return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
    }
    if (this.containerExitCode === undefined) {
      return { ...actionability.unknown, fingerprint_suffix: "engine_command_inspect" };
    }
    if (this.containerExitCode === 137) {
      return { ...actionability.unknown, fingerprint_suffix: "container_killed" };
    }
    if (this.containerExitCode === 0 || externalTerminationExitCodes.has(this.containerExitCode)) {
      return { ...actionability.unknown, fingerprint_suffix: "runtime_stopped" };
    }
    return actionability.runtimeCrash;
  }

  /** Keeps the user-visible remediation in sync with the actionability above. */
  get suggestion(): string | undefined {
    if (this.oomKilled) return SUGGEST_CONTAINER_MEMORY_LIMIT;
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

/** A `functions serve` input or project setting is invalid or missing before the container starts. */
export class ServeConfigError extends Data.TaggedError("ServeConfigError")<{
  readonly message: string;
  readonly reason:
    | "inspect_flags"
    | "signing_keys_invalid"
    | "jwt_secret"
    | "deno_version"
    | "missing_import";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "inspect_flags":
        return { ...actionability.provideFlags, fingerprint_suffix: "flags" };
      case "signing_keys_invalid":
        return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_content" };
      case "jwt_secret":
        return { ...actionability.invalidConfig, fingerprint_suffix: "invalid_config" };
      case "deno_version":
        return { ...actionability.invalidConfig, fingerprint_suffix: "project_config" };
      case "missing_import":
        return { ...actionability.invalidInput, fingerprint_suffix: "not_found" };
      default:
        return actionability.invalidInput;
    }
  }
}

/** The `--env-file` / functions env input is missing, can't be read, doesn't parse, or has an invalid name. */
export class ServeEnvFileError extends Data.TaggedError("ServeEnvFileError")<{
  readonly message: string;
  readonly reason: "not_found" | "read" | "syntax" | "env_name";
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "not_found":
        return { ...actionability.invalidInput, fingerprint_suffix: "not_found" };
      case "syntax":
        return { ...actionability.invalidInput, fingerprint_suffix: "invalid_content" };
      case "env_name":
        return { ...actionability.invalidInput, fingerprint_suffix: "functions_env" };
      default:
        return (
          causeDeclaration(this.cause) ?? {
            ...actionability.toolFailed,
            fingerprint_suffix: "filesystem_io",
          }
        );
    }
  }
}

/** Reading the signing-keys file or staging env files on the host failed during `functions serve`. */
export class ServeFilesystemError extends Data.TaggedError("ServeFilesystemError")<{
  readonly message: string;
  readonly step: "signing_keys_read" | "env_staging";
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return (
      causeDeclaration(this.cause) ?? {
        ...actionability.toolFailed,
        fingerprint_suffix: "filesystem_io",
      }
    );
  }
}

export type EdgeRuntimeDockerStepReason =
  | "daemon_down"
  | "port_in_use"
  | "name_conflict"
  | "mount_denied"
  | "disk_full"
  | "other";

const edgeRuntimeStepSuffix = {
  create: "engine_command_create",
  cp: "engine_command_copy",
  start: "engine_command_start",
} as const;

/** A `docker create`, `docker cp` or `docker start` step for the Edge Runtime container failed. */
export class EdgeRuntimeDockerStepError extends Data.TaggedError("EdgeRuntimeDockerStepError")<{
  readonly message: string;
  readonly step: "create" | "cp" | "start";
  readonly reason: EdgeRuntimeDockerStepReason;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "daemon_down":
        return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
      case "port_in_use":
        return { ...actionability.invalidConfig, fingerprint_suffix: "port_conflict" };
      case "name_conflict":
        return { ...actionability.invalidInput, fingerprint_suffix: "conflict" };
      case "mount_denied":
        return { ...actionability.invalidConfig, fingerprint_suffix: "container_configuration" };
      case "disk_full":
        return { ...actionability.resourceLimit, fingerprint_suffix: "disk_full" };
      default:
        return {
          ...actionability.runtimeCrash,
          fingerprint_suffix: edgeRuntimeStepSuffix[this.step] ?? "engine_command_create",
        };
    }
  }

  get suggestion(): string | undefined {
    return this.reason === "daemon_down" ? SUGGEST_DOCKER_START_RERUN : undefined;
  }
}

/** Creating the Docker network or named volume that `functions serve` needs failed. */
export class DockerResourceCreateError extends Data.TaggedError("DockerResourceCreateError")<{
  readonly message: string;
  readonly resource: "network" | "volume";
  readonly reason: "daemon_down" | "address_pool" | "other";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "daemon_down":
        return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
      case "address_pool":
        return { ...actionability.invalidConfig, fingerprint_suffix: "container_configuration" };
      default:
        return { ...actionability.runtimeCrash, fingerprint_suffix: "engine_command_create" };
    }
  }

  get suggestion(): string | undefined {
    return this.reason === "daemon_down" ? SUGGEST_DOCKER_START_RERUN : undefined;
  }
}

/** Reads the stderr of a failed Edge Runtime `docker create|cp|start` into a closed reason. */
export const classifyEdgeRuntimeDockerStepStderr = (
  stderr: string,
): EdgeRuntimeDockerStepReason => {
  if (isDockerDaemonUnreachable(stderr)) return "daemon_down";
  if (
    /port is already allocated|address already in use|ports are not available|bind: an attempt was made to access a socket/iu.test(
      stderr,
    )
  ) {
    return "port_in_use";
  }
  if (/is already in use by container|container name .* is already in use/iu.test(stderr)) {
    return "name_conflict";
  }
  if (
    /mounts denied|is not shared from the host|bind source path does not exist|has not been shared/iu.test(
      stderr,
    )
  ) {
    return "mount_denied";
  }
  if (/no space left on device/iu.test(stderr)) return "disk_full";
  return "other";
};

/** Reads the stderr of a failed `docker network|volume create` into a closed reason. */
export const classifyDockerResourceCreateStderr = (
  stderr: string,
): "daemon_down" | "address_pool" | "other" => {
  if (isDockerDaemonUnreachable(stderr)) return "daemon_down";
  if (
    /pool overlaps|all predefined address pools have been fully subnetted|non-overlapping .*address pool/iu.test(
      stderr,
    )
  ) {
    return "address_pool";
  }
  return "other";
};
