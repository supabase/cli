/**
 * Pure Postgres connection-string helpers. Used only to build the `.env` file's
 * `POSTGRES_URL`/derived keys (`bootstrap.dotenv.ts`) — no live DB connection here.
 * The push step's actual connection is resolved separately, by
 * `legacyResolveLinkedConn` (`legacy-db-config.layer.ts`), which reproduces the
 * *rest* of `NewDbConfigWithPassword` this module doesn't: the direct-host
 * reachability probe and the IPv4 pooler fallback for IPv6-only projects.
 */

export interface LegacyDbConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

// `url.UserPassword` escapes userinfo with the `encodeUserPassword` mode:
// unreserved chars + the sub-delims `$ & + , ; =` pass through; the reserved
// `@ / ? :` and everything else are percent-encoded (`net/url.shouldEscape`).
const USERINFO_UNESCAPED = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~$&+,;=".split(""),
);

// `url.PathEscape` uses `encodePathSegment`: escape `/ ; , ?` and anything
// outside unreserved + the remaining reserved sub-delims `$ & + : = @`.
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
 * Reproduces `ToPostgresURL`:
 * `postgresql://<user>:<pass>@<host>:<port>/<db>?connect_timeout=10`, with
 * percent-encoded userinfo, a path-escaped database, and IPv6 hosts wrapped in
 * square brackets. Bootstrap passes no `RuntimeParams`, so the only query
 * parameter is the default `connect_timeout=10`.
 */
export function toPostgresUrl(config: LegacyDbConfig): string {
  const userinfo = `${percentEscape(config.user, USERINFO_UNESCAPED)}:${percentEscape(
    config.password,
    USERINFO_UNESCAPED,
  )}`;
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  const database = percentEscape(config.database, PATH_SEGMENT_UNESCAPED);
  return `postgresql://${userinfo}@${host}:${config.port}/${database}?connect_timeout=10`;
}

/**
 * Derives the remote project's naive direct (session-mode) connection shape —
 * `host = db.<ref>.<projectHost>`, `user = postgres`, `database = postgres`,
 * direct port `5432` — for the `.env` file only. Unlike
 * `flags.NewDbConfigWithPassword`, this never probes reachability or falls back
 * to the IPv4 pooler, so on an IPv6-only project the `.env`'s `POSTGRES_URL`
 * (and derived keys) point at a host the user's own machine may not be able to
 * reach directly — a pre-existing, narrow divergence tracked as out-of-scope
 * for CLI-1953 (which fixed this same gap for the actual push connection;
 * see `legacyResolveLinkedConn`).
 */
export function deriveDbConfig(ref: string, password: string, projectHost: string): LegacyDbConfig {
  return {
    host: `db.${ref}.${projectHost}`,
    port: 5432,
    user: "postgres",
    password,
    database: "postgres",
  };
}
