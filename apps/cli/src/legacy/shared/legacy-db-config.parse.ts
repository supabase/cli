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

/**
 * Resolve the libpq `PGPORT` fallback. An unset/empty value (`undefined` from
 * `libpqEnv`) uses the default 5432, a numeric value is used, and a present
 * non-numeric value returns `undefined` so the caller rejects the DSN — pgconn's
 * `parsePort` reports an `invalid port` parse error rather than defaulting.
 */
function libpqPort(raw: string | undefined): number | undefined {
  if (raw === undefined) return DIRECT_PORT;
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** Strip the brackets WHATWG `URL.hostname` keeps around an IPv6 literal (`[::1]`). */
function unbracketIpv6(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
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
  // Match pgconn's dispatch (`config.go:236`): only a literal `postgres://` /
  // `postgresql://` prefix is parsed as a URL; everything else is a libpq
  // keyword/value DSN. So a mistyped scheme like `https://host/db` falls through
  // to the DSN parser, which rejects it (no `key=value`) → the caller surfaces a
  // redacted parse error rather than connecting to a bogus host.
  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) {
    return parseUrlConnectionString(value);
  }
  return parseKeywordValueDsn(trimmed);
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
    const query = url.searchParams;
    // pgconn's `parseURLSettings` runs the query-param loop **last**, so libpq
    // URL query settings (`?host=/socket`, `?port=`, `?dbname=`, `?user=`,
    // `?password=`) override the structural userinfo/host/path. A non-empty query
    // value wins; otherwise we fall back to the structural part. `searchParams`
    // already percent-decodes, so query values are used verbatim.
    const queryOrElse = (key: string, structural: string): string => {
      const q = query.get(key);
      return q !== null && q.length > 0 ? q : structural;
    };

    // A URL that omits a field falls back to the libpq `PG*` env vars and then the
    // libpq defaults, matching pgconn's
    // `mergeSettings(defaultSettings, envSettings, connStringSettings)`.
    const rawUser = queryOrElse("user", decodeURIComponent(url.username));
    const user = rawUser.length > 0 ? rawUser : defaultOsUser();
    const rawPassword = queryOrElse("password", decodeURIComponent(url.password));
    // WHATWG `URL.hostname` keeps the brackets around an IPv6 literal (`[::1]`),
    // but `net`/node-postgres and `PGHOST` expect the bare address. Go's
    // `url.Hostname()` returns the unbracketed host and only re-adds brackets when
    // formatting a URL (`ToPostgresURL`), so strip them here.
    const rawHost = queryOrElse("host", unbracketIpv6(url.hostname));
    const rawDatabase = queryOrElse("dbname", decodeURIComponent(url.pathname.replace(/^\//, "")));
    // libpq fills `sslmode` from `PGSSLMODE` when the connection string omits it
    // (pgconn's `parseEnvSettings`), before the TLS-mode default.
    const sslmode = url.searchParams.get("sslmode") ?? libpqEnv("PGSSLMODE") ?? null;
    const options = url.searchParams.get("options");
    // pgconn merges a `?port=` query setting over the structural port and then
    // parses it, so an explicit query port — even empty (`?port=`) or non-numeric
    // — that is not a valid number is a parse error. A bad `PGPORT` fallback is
    // likewise rejected (`libpqPort` → undefined). `url.port` is always digits.
    const portQuery = query.get("port");
    if (portQuery !== null && !/^\d+$/.test(portQuery)) {
      return undefined;
    }
    const rawPort = portQuery ?? url.port;
    const port = rawPort.length > 0 ? Number(rawPort) : libpqPort(libpqEnv("PGPORT"));
    if (port === undefined) {
      return undefined;
    }
    return {
      host: rawHost.length > 0 ? rawHost : (libpqEnv("PGHOST") ?? defaultLibpqHost()),
      port,
      user,
      password: rawPassword.length > 0 ? rawPassword : (libpqEnv("PGPASSWORD") ?? ""),
      // Absent database → PGDATABASE, then the resolved user (libpq default).
      database: rawDatabase.length > 0 ? rawDatabase : (libpqEnv("PGDATABASE") ?? user),
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
  // Explicit non-numeric `port=` → NaN; a bad `PGPORT` fallback → undefined.
  if (port === undefined || Number.isNaN(port)) return undefined;
  const user = params.get("user") ?? defaultOsUser();
  const database =
    params.get("dbname") ?? libpqEnv("PGDATABASE") ?? (user.length > 0 ? user : "postgres");
  // libpq fills `sslmode` from `PGSSLMODE` when the DSN omits it (pgconn's
  // `parseEnvSettings`), before the TLS-mode default.
  const sslmode = params.get("sslmode") ?? libpqEnv("PGSSLMODE");
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
