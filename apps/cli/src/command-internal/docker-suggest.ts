import { containerRuntimeNotFoundMessage } from "./container-cli.ts";

/** Prerequisite hint shown whenever a container-runtime call fails because the daemon is unreachable. */
export const SUGGEST_DOCKER_INSTALL =
  "Docker Desktop is a prerequisite for local development. Follow the official docs to install: https://docs.docker.com/desktop";

/** Remediation for a daemon that answered earlier in the session and then went away, as opposed to `SUGGEST_DOCKER_INSTALL`'s missing-binary case. */
export const SUGGEST_DOCKER_START =
  "Docker is no longer reachable. Start Docker, then rerun `supabase functions serve`.";

/** Remediation hint shown when the OOM killer kills a container. */
export const SUGGEST_CONTAINER_MEMORY_LIMIT =
  "The container ran out of memory and was killed. Raise the memory allocated to your container runtime (Docker Desktop: Settings > Resources), or free up memory on the host, and try again.";

/** Docker CLI wordings for a daemon that cannot be reached, shared by every daemon-down matcher. */
export const DOCKER_DAEMON_CONNECTION_FAILURE_PATTERN =
  /failed to connect to the docker api|error during connect|is the docker daemon running|permission denied while trying to connect/iu;

/**
 * Whether a container-CLI stderr indicates the daemon is unreachable. Matches the docker/podman
 * "cannot connect" messages, {@link DOCKER_DAEMON_CONNECTION_FAILURE_PATTERN}, and
 * {@link containerRuntimeNotFoundMessage} — a missing CLI binary gets the same install hint
 * as a missing daemon.
 */
export function isDockerDaemonUnreachable(stderr: string): boolean {
  return (
    /cannot connect to the docker daemon|cannot connect to podman/iu.test(stderr) ||
    DOCKER_DAEMON_CONNECTION_FAILURE_PATTERN.test(stderr) ||
    stderr.includes(containerRuntimeNotFoundMessage)
  );
}
