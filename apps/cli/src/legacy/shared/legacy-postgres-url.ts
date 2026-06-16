/**
 * Build a `postgresql://` URL from a resolved connection, mirroring Go's
 * `utils.ToPostgresURL` (`apps/cli-go/internal/utils/connect.go:25-47`). Used to
 * feed live database endpoints to the pg-delta edge-runtime scripts (SOURCE /
 * TARGET). TLS (`sslmode`) is intentionally omitted — Go's `ToPostgresURL`
 * serializes only `RuntimeParams` (sslmode lives in `pgconn.Config.TLSConfig`,
 * not `RuntimeParams`); pg-delta's SSL is layered on separately by
 * `PreparePgDeltaPostgresRef` for remote endpoints.
 */

/** Mirrors Go's IPv6 check (`net.ParseIP(host) != nil && ip.To4() == nil`). */
function isIPv6Host(host: string): boolean {
  // Hostnames never contain ':'; a bare IPv6 literal always does.
  return host.includes(":");
}

export interface LegacyPostgresUrlInput {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /** `pgconn.Config.ConnectTimeout` in seconds; defaults to 10 when 0/absent. */
  readonly connectTimeoutSeconds?: number;
}

export function legacyToPostgresURL(conn: LegacyPostgresUrlInput): string {
  const timeout =
    conn.connectTimeoutSeconds !== undefined && conn.connectTimeoutSeconds > 0
      ? conn.connectTimeoutSeconds
      : 10;
  const host = isIPv6Host(conn.host) ? `[${conn.host}]` : conn.host;
  // Go uses url.UserPassword (userinfo escaping) + url.PathEscape (database).
  // encodeURIComponent is a strict superset of those escape sets, so the decoded
  // value pg-delta sees is identical for any input.
  const userinfo = `${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}`;
  return `postgresql://${userinfo}@${host}:${conn.port}/${encodeURIComponent(
    conn.database,
  )}?connect_timeout=${timeout}`;
}
