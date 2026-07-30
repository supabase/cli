import { legacyContainerRuntimeNotFoundMessage } from "./legacy-container-cli.ts";

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
 * followed by "Is the docker daemon running?") when the socket is down, and
 * "permission denied while trying to connect to the Docker daemon socket …"
 * when the socket exists but the user can't open it — the pinned Docker SDK
 * classifies that permission error as a connection failure too
 * (`client/request.go:144-152`, docker/docker v28.5.2: `os.IsPermission` →
 * `errConnectionFailed`), so Go surfaces the install hint for it as well.
 *
 * Also matches `spawnContainerCli`'s runtime-not-found message
 * (`legacyContainerRuntimeNotFoundMessage`, imported from
 * `legacy-container-cli.ts` rather than duplicated here so the producer and
 * this classifier can't drift apart): a missing container-CLI binary is the
 * shell-out equivalent of Go's missing daemon socket — on a machine with no
 * Docker installed, Go's socket dial fails, `client.IsErrConnectionFailed`
 * fires, and the install hint is exactly the guidance that case needs
 * (`misc.go:155-166`).
 *
 * "error during connect" is the pinned SDK's uniform outer wrap for every
 * transport-level failure (`client/request.go:175-185`, docker/docker
 * v28.5.2) and therefore the closest 1:1 stderr equivalent of
 * `errConnectionFailed`'s breadth. It notably covers Windows daemon-down,
 * where a failed npipe open is wrapped as "error during connect: this error
 * may indicate that the docker daemon is not running: …" (elevated,
 * `request.go:181`) or "… the docker client must be run with elevated
 * privileges …" (non-elevated, `request.go:178`) — word orders none of the
 * Unix-socket phrases match. The inner OS text ("The system cannot find the
 * file specified") is localized per the SDK's own comment
 * (`request.go:172-174`), so it is deliberately not matched.
 */
export function legacyIsDockerDaemonUnreachable(stderr: string): boolean {
  return (
    /cannot connect to the docker daemon|cannot connect to podman|is the docker daemon running|permission denied while trying to connect|error during connect/iu.test(
      stderr,
    ) || stderr.includes(legacyContainerRuntimeNotFoundMessage)
  );
}
