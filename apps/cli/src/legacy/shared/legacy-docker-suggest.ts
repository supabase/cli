/**
 * Go's Docker prerequisite hint (`apps/cli-go/internal/utils/docker.go:350`,
 * `suggestDockerInstall`). Go sets it as `CmdSuggestion` — rendered as a separate
 * "Suggestion:" line — whenever a container-runtime call fails because the daemon
 * is unreachable (`client.IsErrConnectionFailed`, `misc.go:148-154`).
 */
export const LEGACY_SUGGEST_DOCKER_INSTALL =
  "Docker Desktop is a prerequisite for local development. Follow the official docs to install: https://docs.docker.com/desktop";

/**
 * Whether a container-CLI stderr indicates the daemon is unreachable — the
 * subprocess-stderr equivalent of Go's `client.IsErrConnectionFailed` (which
 * inspects the Docker API client error). The docker / podman CLIs print
 * "Cannot connect to the Docker daemon …" / "Cannot connect to Podman …" (often
 * followed by "Is the docker daemon running?") when the socket is down.
 */
export function legacyIsDockerDaemonUnreachable(stderr: string): boolean {
  return /cannot connect to the docker daemon|cannot connect to podman|is the docker daemon running/iu.test(
    stderr,
  );
}
