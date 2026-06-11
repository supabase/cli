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
        // WHATWG `URL.hostname` returns an IPv6 host bracketed (`[::1]`), but Go's
        // `net.SplitHostPort` (`misc.go:307`) returns the bare host (`::1`). Strip a
        // single surrounding bracket pair so local-stack probes dial/compare the
        // same host Go does; IPv4 and named hosts are returned unchanged.
        const host = url.hostname;
        return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
      }
    } catch {
      // Unparseable DOCKER_HOST → fall through to the loopback default.
    }
  }
  return LOCAL_HOST;
}
