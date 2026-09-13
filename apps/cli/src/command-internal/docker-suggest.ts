import { containerRuntimeNotFoundMessage } from "./container-cli.ts";

/** Prerequisite hint shown whenever a container-runtime call fails because the daemon is unreachable. */
export const SUGGEST_DOCKER_INSTALL =
  "Docker Desktop is a prerequisite for local development. Follow the official docs to install: https://docs.docker.com/desktop";

/**
 * Whether a container-CLI stderr indicates the daemon is unreachable. Matches the docker/podman
 * "cannot connect"/"is the docker daemon running" messages, a socket permission-denied message,
 * the generic "error during connect" wrapper (which also covers Windows npipe daemon-down text),
 * and {@link containerRuntimeNotFoundMessage} — a missing CLI binary gets the same install hint
 * as a missing daemon.
 */
export function isDockerDaemonUnreachable(stderr: string): boolean {
  return (
    /cannot connect to the docker daemon|cannot connect to podman|is the docker daemon running|permission denied while trying to connect|error during connect/iu.test(
      stderr,
    ) || stderr.includes(containerRuntimeNotFoundMessage)
  );
}
