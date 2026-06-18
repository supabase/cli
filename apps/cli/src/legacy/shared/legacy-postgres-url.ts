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

/**
 * Mirrors Go's `url.QueryEscape`: every byte outside the unreserved set
 * `A-Za-z0-9-_.~` is percent-encoded from its UTF-8 bytes, and space becomes `+`.
 * Used for `RuntimeParams` values so the serialized query string is byte-identical
 * to Go's `ToPostgresURL` (`encodeURIComponent` differs on space and `!*'()`).
 */
function goQueryEscape(value: string): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      out += ch;
    } else if (ch === " ") {
      out += "+";
    } else {
      for (const byte of new TextEncoder().encode(ch)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

export interface LegacyPostgresUrlInput {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /** `pgconn.Config.ConnectTimeout` in seconds; defaults to 10 when 0/absent. */
  readonly connectTimeoutSeconds?: number;
  /**
   * libpq `options` startup parameter (Go's `pgconn.Config.RuntimeParams["options"]`,
   * e.g. `reference=<ref>` for Supavisor pooler tenant routing).
   */
  readonly options?: string;
  /**
   * The remaining libpq startup `RuntimeParams` (e.g. `search_path`,
   * `statement_timeout`). Go's `ToPostgresURL` appends every `RuntimeParams` entry, so
   * a custom `--db-url`'s session settings reach pg-delta. Emitted in sorted key order
   * (Go iterates a map, so the exact order is not a parity contract).
   */
  readonly runtimeParams?: Readonly<Record<string, string>>;
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
  // Mirror Go's `connect_timeout` + `RuntimeParams` loop (`connect.go:30-33`): the
  // pooler tenant-routing `options` must reach pg-delta or the connection misses
  // the tenant on pooler fallback.
  const optionsParam =
    conn.options !== undefined && conn.options.length > 0
      ? `&options=${goQueryEscape(conn.options)}`
      : "";
  // Every other runtime param (search_path, statement_timeout, …), sorted for a stable
  // serialization (Go iterates a map, so order is not a parity contract).
  const extraParams =
    conn.runtimeParams === undefined
      ? ""
      : Object.keys(conn.runtimeParams)
          .sort()
          .map((key) => `&${goQueryEscape(key)}=${goQueryEscape(conn.runtimeParams![key]!)}`)
          .join("");
  return `postgresql://${userinfo}@${host}:${conn.port}/${encodeURIComponent(
    conn.database,
  )}?connect_timeout=${timeout}${optionsParam}${extraParams}`;
}
