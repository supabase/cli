import type { LegacyPgConnInput } from "./legacy-db-connection.service.ts";

/** Go's `pgconn` default direct Postgres port. */
const DIRECT_PORT = 5432;

/**
 * Parse a Postgres connection string into a `LegacyPgConnInput`. Mirrors Go's
 * `pgconn.ParseConfig` (`apps/cli-go/internal/utils/flags/db_url.go:64`), which
 * accepts **both** the WHATWG `postgres(ql)://…` URL form and the libpq
 * keyword/value DSN form (`host=… dbname=… user=…`, including unix-socket paths).
 * Returns `undefined` on any malformed input so callers can surface a redacted
 * parse error instead of crashing with an unhandled defect.
 *
 * `sslmode` and the libpq `options` startup parameter are preserved (Go keeps
 * them in `pgconn.Config`): `options` carries the legacy Supavisor
 * `?options=reference=<ref>` tenant routing, and `sslmode` controls TLS.
 */
export function parseLegacyConnectionString(value: string): LegacyPgConnInput | undefined {
  const trimmed = value.trim();
  // libpq keyword/value DSNs have no `://` scheme but contain `key=value` pairs.
  // `new URL()` would silently mis-parse them (everything after the first space
  // lands in the path), so route them through the dedicated parser.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) && /[a-zA-Z_]+\s*=/.test(trimmed)) {
    return parseKeywordValueDsn(trimmed);
  }
  return parseUrlConnectionString(value);
}

/** Parse the WHATWG `postgres(ql)://` URL form. */
function parseUrlConnectionString(value: string): LegacyPgConnInput | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  try {
    // `decodeURIComponent` throws on a malformed percent escape (e.g. `p%zz`).
    // Keep it inside the try so a bad escape yields a normal parse failure
    // rather than an untyped defect (CWE-209-safe: the caller redacts the URL).
    const user = decodeURIComponent(url.username);
    const database = url.pathname.replace(/^\//, "");
    const sslmode = url.searchParams.get("sslmode");
    const options = url.searchParams.get("options");
    return {
      host: url.hostname,
      port: url.port.length > 0 ? Number(url.port) : DIRECT_PORT,
      user,
      password: decodeURIComponent(url.password),
      database:
        database.length > 0 ? decodeURIComponent(database) : user.length > 0 ? user : "postgres",
      ...(options !== null && options.length > 0 ? { options } : {}),
      ...(sslmode !== null && sslmode.length > 0 ? { sslmode } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Parse a libpq keyword/value DSN per the connection-string rules: whitespace-
 * separated `keyword = value` pairs, with single-quoted values and backslash
 * escapes. Unknown keywords are ignored. Defaults mirror libpq/pgconn: the user
 * falls back to the OS account, the database to the user, and the port to 5432.
 */
function parseKeywordValueDsn(value: string): LegacyPgConnInput | undefined {
  const params = new Map<string, string>();
  const n = value.length;
  let i = 0;
  const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  while (i < n) {
    while (i < n && isSpace(value[i]!)) i++;
    if (i >= n) break;
    // Keyword: up to whitespace or `=`.
    const keyStart = i;
    while (i < n && !isSpace(value[i]!) && value[i] !== "=") i++;
    const key = value.slice(keyStart, i);
    while (i < n && isSpace(value[i]!)) i++;
    if (value[i] !== "=") return undefined;
    i++;
    while (i < n && isSpace(value[i]!)) i++;
    // Value: single-quoted (with `\` escapes) or bare (until whitespace).
    let val = "";
    if (value[i] === "'") {
      i++;
      while (i < n && value[i] !== "'") {
        if (value[i] === "\\" && i + 1 < n) i++;
        val += value[i];
        i++;
      }
      if (value[i] !== "'") return undefined;
      i++;
    } else {
      while (i < n && !isSpace(value[i]!)) {
        if (value[i] === "\\" && i + 1 < n) i++;
        val += value[i];
        i++;
      }
    }
    if (key.length > 0) params.set(key, val);
  }
  const host = params.get("host") ?? params.get("hostaddr") ?? "";
  const portRaw = params.get("port");
  const port = portRaw !== undefined && portRaw.length > 0 ? Number(portRaw) : DIRECT_PORT;
  if (Number.isNaN(port)) return undefined;
  const user = params.get("user") ?? defaultOsUser();
  const database = params.get("dbname") ?? (user.length > 0 ? user : "postgres");
  const sslmode = params.get("sslmode");
  const options = params.get("options");
  return {
    host,
    port,
    user,
    password: params.get("password") ?? "",
    database,
    ...(options !== undefined && options.length > 0 ? { options } : {}),
    ...(sslmode !== undefined && sslmode.length > 0 ? { sslmode } : {}),
  };
}

/** libpq's default user is the OS account (pgconn calls `user.Current()`). */
function defaultOsUser(): string {
  return process.env["USER"] ?? process.env["USERNAME"] ?? "postgres";
}

/**
 * Mask the password in a connection string for safe inclusion in error output
 * (CWE-209): a malformed `--db-url` often still carries a secret. Pure string
 * replacement (not `URL.toString()`, which would percent-encode the literal
 * `[REDACTED]`) covers URL userinfo (`://user:secret@`), the malformed-but-
 * credential-bearing URL case, and libpq keyword/value DSNs (`password=…` /
 * `password='…'`).
 */
export function redactLegacyConnectionString(value: string): string {
  return value
    .replace(/(:\/\/[^:@/]*:)[^@/]*(@)/, "$1[REDACTED]$2")
    .replace(/(\bpassword\s*=\s*)('(?:[^'\\]|\\.)*'|\S+)/i, "$1[REDACTED]");
}
