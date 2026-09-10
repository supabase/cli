/**
 * Builds a `postgresql://` URL from a resolved connection. TLS (`sslmode`) is intentionally
 * omitted; it's negotiated separately, not serialized into the URL's query string.
 */

function isIPv6Host(host: string): boolean {
  // Hostnames never contain ':'; a bare IPv6 literal always does.
  return host.includes(":");
}

/**
 * Percent-encodes every byte outside the unreserved set `A-Za-z0-9-_.~` from its UTF-8 bytes,
 * and turns space into `+` (`application/x-www-form-urlencoded` query-escaping, not
 * `encodeURIComponent`, which differs on space and `!*'()`).
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

export interface PostgresUrlInput {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /** Connect timeout in seconds; defaults to 10 when 0/absent. */
  readonly connectTimeoutSeconds?: number;
  /** libpq `options` startup parameter, e.g. `reference=<ref>` for Supavisor pooler tenant routing. */
  readonly options?: string;
  /**
   * The remaining libpq startup parameters (e.g. `search_path`, `statement_timeout`) so a
   * custom `--db-url`'s session settings reach pg-delta. Emitted in sorted key order.
   */
  readonly runtimeParams?: Readonly<Record<string, string>>;
}

export function toPostgresURL(conn: PostgresUrlInput): string {
  const timeout =
    conn.connectTimeoutSeconds !== undefined && conn.connectTimeoutSeconds > 0
      ? conn.connectTimeoutSeconds
      : 10;
  const host = isIPv6Host(conn.host) ? `[${conn.host}]` : conn.host;
  // encodeURIComponent is a strict superset of libpq's userinfo/path escaping, so the
  // decoded value pg-delta sees is identical for any input.
  const userinfo = `${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}`;
  // The pooler tenant-routing `options` must reach pg-delta, or the connection misses the
  // tenant on pooler fallback.
  const optionsParam =
    conn.options !== undefined && conn.options.length > 0
      ? `&options=${goQueryEscape(conn.options)}`
      : "";
  // Every other runtime param (search_path, statement_timeout, …), sorted for stable
  // serialization.
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
