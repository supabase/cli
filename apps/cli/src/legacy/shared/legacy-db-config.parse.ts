import { existsSync } from "node:fs";
import type { LegacyPgConnInput } from "./legacy-db-connection.service.ts";

/** Go's `pgconn` default direct Postgres port. */
const DIRECT_PORT = 5432;

/** Read a libpq `PG*` env var, treating empty as unset (pgconn's `parseEnvSettings`). */
function libpqEnv(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * libpq's default host when the connection string omits one. Mirrors pgconn's
 * `defaultHost` (`defaults.go`): on non-Windows it returns the first existing
 * common unix-socket directory, else `localhost`; Windows always uses
 * `localhost`. `PGHOST` (applied by the callers) takes priority over this.
 */
function defaultLibpqHost(): string {
  if (process.platform === "win32") return "localhost";
  for (const candidate of ["/var/run/postgresql", "/private/tmp", "/tmp"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "localhost";
}

/** Resolve a libpq port string to a number, falling back to 5432 when unusable. */
function libpqPort(raw: string | undefined): number {
  if (raw !== undefined && /^\d+$/.test(raw)) return Number(raw);
  return DIRECT_PORT;
}

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
    // A URL that omits userinfo falls back to the OS account, matching Go's
    // `pgconn.ParseConfig` (`defaultSettings`/`PGUSER`) and the keyword/value
    // path below — not the empty string `url.username` yields.
    const rawUser = decodeURIComponent(url.username);
    const user = rawUser.length > 0 ? rawUser : defaultOsUser();
    const rawPassword = decodeURIComponent(url.password);
    const database = url.pathname.replace(/^\//, "");
    const sslmode = url.searchParams.get("sslmode");
    const options = url.searchParams.get("options");
    // Omitted fields fall back to libpq `PG*` env vars and then the libpq
    // defaults, matching pgconn's
    // `mergeSettings(defaultSettings, envSettings, connStringSettings)`.
    return {
      host: url.hostname.length > 0 ? url.hostname : (libpqEnv("PGHOST") ?? defaultLibpqHost()),
      port: url.port.length > 0 ? Number(url.port) : libpqPort(libpqEnv("PGPORT")),
      user,
      password: rawPassword.length > 0 ? rawPassword : (libpqEnv("PGPASSWORD") ?? ""),
      // Absent database → PGDATABASE, then the resolved user (libpq default).
      database:
        database.length > 0 ? decodeURIComponent(database) : (libpqEnv("PGDATABASE") ?? user),
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
  // Omitted fields fall back to libpq `PG*` env vars and then the libpq defaults,
  // matching pgconn's `mergeSettings(defaultSettings, envSettings, connStringSettings)`.
  const host =
    params.get("host") ?? params.get("hostaddr") ?? libpqEnv("PGHOST") ?? defaultLibpqHost();
  const portRaw = params.get("port");
  const port =
    portRaw !== undefined && portRaw.length > 0 ? Number(portRaw) : libpqPort(libpqEnv("PGPORT"));
  if (Number.isNaN(port)) return undefined;
  const user = params.get("user") ?? defaultOsUser();
  const database =
    params.get("dbname") ?? libpqEnv("PGDATABASE") ?? (user.length > 0 ? user : "postgres");
  const sslmode = params.get("sslmode");
  const options = params.get("options");
  return {
    host,
    port,
    user,
    password: params.get("password") ?? libpqEnv("PGPASSWORD") ?? "",
    database,
    ...(options !== undefined && options.length > 0 ? { options } : {}),
    ...(sslmode !== undefined && sslmode.length > 0 ? { sslmode } : {}),
  };
}

/**
 * libpq's default user when the connection string omits one. Mirrors `pgconn`'s
 * `mergeSettings(defaultSettings, envSettings, connStringSettings)`
 * (`config.go:249`): `PGUSER` (an env setting) takes priority over the OS account
 * (`defaultSettings` → `user.Current()`), while an explicit `user=`/userinfo in
 * the connection string still wins over both (handled by the callers). The final
 * `"postgres"` guard covers minimal environments where neither is available.
 */
function defaultOsUser(): string {
  return process.env["PGUSER"] ?? process.env["USER"] ?? process.env["USERNAME"] ?? "postgres";
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
