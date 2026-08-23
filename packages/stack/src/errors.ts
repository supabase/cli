import { Data, Predicate } from "effect";

export class BinaryNotFoundError extends Data.TaggedError("BinaryNotFoundError")<{
  readonly service: string;
  readonly platform: string;
}> {}

export class DownloadError extends Data.TaggedError("DownloadError")<{
  readonly url: string;
  readonly cause: unknown;
}> {}

export class ChecksumMismatchError extends Data.TaggedError("ChecksumMismatchError")<{
  readonly url: string;
  readonly expected: string;
  readonly actual: string;
}> {}

export class BinaryManifestError extends Data.TaggedError("BinaryManifestError")<{
  readonly url: string;
  readonly detail: string;
}> {}

export class BinaryRuntimeError extends Data.TaggedError("BinaryRuntimeError")<{
  readonly path: string;
  readonly detail: string;
}> {}

export class BinaryHostCompatibilityError extends Data.TaggedError("BinaryHostCompatibilityError")<{
  readonly target: string;
  readonly detail: string;
}> {}

export class DockerPullError extends Data.TaggedError("DockerPullError")<{
  readonly image: string;
  readonly detail: string;
  readonly cause: unknown;
  /**
   * Whether the pull failed because the container runtime itself is unusable
   * locally — the daemon is unreachable (detected from the runtime's output
   * at the boundary where it is produced) or the docker binary could not be
   * spawned at all. Consumers must branch on this instead of sniffing
   * `detail` text.
   */
  readonly daemonDown: boolean;
}> {}

/**
 * Whether a container runtime's output indicates the daemon itself is not
 * running. This is the boundary vocabulary for `DockerPullError.daemonDown`
 * and shared with the CLI's legacy docker-run layer so both paths agree on
 * what "daemon down" looks like.
 */
export const isDockerDaemonDownMessage = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("cannot connect to the docker daemon") ||
    normalized.includes("docker daemon is not running") ||
    normalized.includes("docker desktop is not running") ||
    normalized.includes("is the docker daemon running") ||
    normalized.includes("cannot connect to podman") ||
    normalized.includes("error during connect") ||
    // Spawn succeeds but the socket is not accessible (e.g. a Linux user
    // missing docker group membership) — a local setup problem, not a
    // registry failure.
    normalized.includes("permission denied while trying to connect to the docker daemon")
  );
};

export class StackBuildError extends Data.TaggedError("StackBuildError")<{
  readonly detail: string;
  readonly cause?: unknown;
  /**
   * Structured discriminant for consumers that need to distinguish failure
   * classes without parsing `detail`: `invalid_config` for user-fixable
   * configuration problems, `docker_not_running` for an unavailable local
   * runtime, and `asset_preparation` for other download/registry failures.
   * Absent for internal invariant violations.
   */
  readonly reason?: "invalid_config" | "docker_not_running" | "asset_preparation";
}> {}

/** Runtime RPC is unavailable until the supervisor publishes a running stack. */
export class StackUnavailableError extends Data.TaggedError("StackUnavailableError")<{
  readonly phase: "starting" | "stopping" | "failed" | "deleting";
  readonly detail?: string;
}> {}

/** A remote RPC request could not reach the owner endpoint. */
export class StackRpcTransportError extends Data.TaggedError("StackRpcTransportError")<{
  readonly endpoint: string;
  readonly procedure: string;
  readonly cause: unknown;
}> {}

/** A same-build RPC response violated the framed/schema protocol. */
export class StackRpcProtocolError extends Data.TaggedError("StackRpcProtocolError")<{
  readonly endpoint: string;
  readonly procedure: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export class StackNotRunningError extends Data.TaggedError("StackNotRunningError")<{
  readonly phase: string;
}> {}

export class StackReadinessError extends Data.TaggedError("StackReadinessError")<{
  readonly target: string;
  readonly timeoutMs: number;
  readonly detail: string;
}> {}

/** The owner is healthy but belongs to another exact CLI build. */
export class DaemonUpgradeRequired extends Data.TaggedError("DaemonUpgradeRequired")<{
  readonly stackId: string;
  readonly oldCliVersion: string;
  readonly oldBuildId: string;
  readonly newCliVersion: string;
  readonly newBuildId: string;
}> {}

export class UpgradePreflightError extends Data.TaggedError("UpgradePreflightError")<{
  readonly stackId: string;
  readonly oldBuildId: string;
  readonly newBuildId: string;
  readonly detail: string;
}> {}

export class UpgradeRestartError extends Data.TaggedError("UpgradeRestartError")<{
  readonly stackId: string;
  readonly newBuildId: string;
  readonly detail: string;
}> {}

export class StopTimeout extends Data.TaggedError("StopTimeout")<{
  readonly endpoint: string;
  readonly ownerSessionId: string;
  readonly lastState?: string;
}> {}

export class PortConflictError extends Data.TaggedError("PortConflictError")<{
  readonly port: number;
  readonly service: string;
}> {}

export class StackError extends Error {
  readonly code: string;
  constructor(opts: { code: string; message: string; cause?: unknown }) {
    super(opts.message, { cause: opts.cause });
    this.code = opts.code;
    this.name = "StackError";
  }
}

const taggedStackErrorCodes = [
  ["ServiceNotFoundError", "SERVICE_NOT_FOUND"],
  ["StackBuildError", "BUILD_ERROR"],
  ["StackNotRunningError", "STACK_NOT_RUNNING"],
  ["StackReadinessError", "STACK_READINESS_TIMEOUT"],
  ["StackUnavailableError", "STACK_UNAVAILABLE"],
  ["StackRpcTransportError", "STACK_RPC_TRANSPORT"],
  ["StackRpcProtocolError", "STACK_RPC_PROTOCOL"],
  ["DaemonUpgradeRequired", "DAEMON_UPGRADE_REQUIRED"],
  ["UpgradePreflightError", "UPGRADE_PREFLIGHT"],
  ["UpgradeRestartError", "UPGRADE_RESTART"],
  ["StopTimeout", "STOP_TIMEOUT"],
  ["BinaryNotFoundError", "BINARY_NOT_FOUND"],
  ["ChecksumMismatchError", "CHECKSUM_MISMATCH"],
  ["BinaryManifestError", "BINARY_MANIFEST"],
  ["BinaryRuntimeError", "BINARY_RUNTIME"],
  ["BinaryHostCompatibilityError", "BINARY_HOST"],
  ["DownloadError", "DOWNLOAD_ERROR"],
  ["DockerPullError", "DOCKER_PULL_ERROR"],
  ["PortConflictError", "PORT_CONFLICT"],
  ["PortAllocationError", "PORT_ALLOCATION"],
  ["ServiceReadyError", "SERVICE_NOT_READY"],
] as const;

const messageForUnknownError = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (error !== null && typeof error === "object" && "detail" in error) {
    const detail = error.detail;
    if (typeof detail === "string" && detail.length > 0) return detail;
  }
  return String(error);
};

export function toStackError(err: unknown): StackError {
  if (err instanceof StackError) return err;
  for (const [tag, code] of taggedStackErrorCodes) {
    if (Predicate.isTagged(err, tag)) {
      return new StackError({
        code,
        message: messageForUnknownError(err),
        cause: err,
      });
    }
  }
  if (err instanceof Error) {
    return new StackError({ code: "UNKNOWN", message: err.message, cause: err });
  }
  return new StackError({ code: "UNKNOWN", message: String(err) });
}
