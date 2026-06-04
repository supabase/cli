/**
 * Pure Postgres connection-string helpers. Ports of Go's `utils.ToPostgresURL`
 * (`apps/cli-go/internal/utils/connect.go`) and the db-config derivation in
 * `flags.NewDbConfigWithPassword`, reduced to just the connection-string
 * components bootstrap needs (no live DB connection).
 */

export interface LegacyDbConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

// Go's `url.UserPassword` escapes userinfo with the `encodeUserPassword` mode:
// unreserved chars + the sub-delims `$ & + , ; =` pass through; the reserved
// `@ / ? :` and everything else are percent-encoded (`net/url.shouldEscape`).
const USERINFO_UNESCAPED = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~$&+,;=".split(""),
);

// Go's `url.PathEscape` uses `encodePathSegment`: escape `/ ; , ?` and anything
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
 * Reproduces Go's `ToPostgresURL`:
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
 * Derives the remote project's direct (session-mode) connection config. Mirrors
 * Go's `flags.NewDbConfigWithPassword`: `host = db.<ref>.<projectHost>`,
 * `user = postgres`, `database = postgres`, direct port `5432`. The pooled
 * (transaction-mode) variant uses the same config with port `6543`.
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
