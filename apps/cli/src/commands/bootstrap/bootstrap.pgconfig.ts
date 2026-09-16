/**
 * Pure Postgres connection-string helpers for the `.env` file's `POSTGRES_URL`/derived keys; no
 * live DB connection here. The push step's actual connection (with reachability probing and IPv4
 * pooler fallback) is resolved separately by `resolveLinkedConn`.
 */

export interface DbConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

// Percent-encodes everything except unreserved chars and the sub-delims `$ & + , ; =`; the
// reserved `@ / ? :` are always escaped.
const USERINFO_UNESCAPED = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~$&+,;=".split(""),
);

// Percent-encodes everything except unreserved chars and the sub-delims `$ & + : = @`; `/ ; , ?`
// are always escaped.
const PATH_SEGMENT_UNESCAPED = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~$&+:=@".split(""),
);

function percentEscape(value: string, allowed: ReadonlySet<string>): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (byte < 0x80 && allowed.has(char)) {
      out += char;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * Renders `postgresql://<user>:<pass>@<host>:<port>/<db>?connect_timeout=10`, with
 * percent-encoded userinfo, a path-escaped database, and IPv6 hosts wrapped in square brackets.
 */
export function toPostgresUrl(config: DbConfig): string {
  const userinfo = `${percentEscape(config.user, USERINFO_UNESCAPED)}:${percentEscape(
    config.password,
    USERINFO_UNESCAPED,
  )}`;
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  const database = percentEscape(config.database, PATH_SEGMENT_UNESCAPED);
  return `postgresql://${userinfo}@${host}:${config.port}/${database}?connect_timeout=10`;
}

/**
 * Derives the remote project's naive direct (session-mode) connection shape for the `.env` file
 * only: `host = db.<ref>.<projectHost>`, `user = postgres`, `database = postgres`, port `5432`.
 * Never probes reachability or falls back to the IPv4 pooler, so on an IPv6-only project the
 * `.env`'s `POSTGRES_URL` may point at a host the user's machine can't reach directly; the actual
 * push connection is resolved separately via `resolveLinkedConn`.
 */
export function deriveDbConfig(ref: string, password: string, projectHost: string): DbConfig {
  return {
    host: `db.${ref}.${projectHost}`,
    port: 5432,
    user: "postgres",
    password,
    database: "postgres",
  };
}
