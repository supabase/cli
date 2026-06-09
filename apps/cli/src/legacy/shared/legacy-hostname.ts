const LOCAL_HOST = "127.0.0.1";

/**
 * Resolves the hostname used for local Supabase service connections, mirroring
 * Go's `utils.GetHostname` (`apps/cli-go/internal/utils/misc.go:298`):
 *
 * 1. `SUPABASE_SERVICES_HOSTNAME` env override — set in dev containers or when
 *    the Docker daemon is not reachable on the container's own loopback.
 * 2. The Docker daemon host when `DOCKER_HOST` is a `tcp://host:port` endpoint
 *    (Go's `Docker.DaemonHost()` + `client.ParseHostURL` + `net.SplitHostPort`).
 * 3. `127.0.0.1` otherwise (the default unix-socket daemon).
 *
 * Shared across legacy commands that connect to the local stack (`gen types`,
 * `test db`, and later `db reset` / `db dump`).
 */
export function legacyGetHostname(): string {
  const override = process.env["SUPABASE_SERVICES_HOSTNAME"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const dockerHost = process.env["DOCKER_HOST"];
  if (dockerHost !== undefined && dockerHost.length > 0) {
    try {
      const url = new URL(dockerHost);
      if (url.protocol === "tcp:" && url.hostname.length > 0) {
        return url.hostname;
      }
    } catch {
      // Unparseable DOCKER_HOST → fall through to the loopback default.
    }
  }
  return LOCAL_HOST;
}
