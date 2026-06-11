import { existsSync } from "node:fs";
import type { LegacyPgConnInput } from "./legacy-db-connection.service.ts";
import { legacyPgpassPassword } from "./legacy-pgpass.ts";

/** Go's `pgconn` default direct Postgres port. */
const DIRECT_PORT = 5432;

/**
 * Environment lookup used for libpq `PG*` fallbacks. Injected so the resolver can
 * layer the project `.env*` files under the shell environment, mirroring Go's
 * `LoadConfig` (`godotenv.Load`) populating `os.Environ` before `pgconn.ParseConfig`
 * reads `PGHOST`/`PGPASSWORD`/`PGSSLMODE`/… (`internal/utils/flags/db_url.go:59-68`).
 * Defaults to `process.env` so the pure call sites (and the pooler path, whose
 * connection string is fully specified) keep their existing behavior.
 */
export type LegacyParseEnv = (name: string) => string | undefined;

const processEnv: LegacyParseEnv = (name) => process.env[name];

/**
 * The `sslmode` values pgconn's `configTLS` accepts; any other value is a parse
 * error (`"sslmode is invalid"`), so the DSN is rejected rather than treated as
 * `prefer`.
 */
const VALID_SSLMODES = new Set([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

/** Whether a resolved sslmode is present and not one pgconn accepts. */
function isInvalidSslmode(sslmode: string | null | undefined): boolean {
  return (
    sslmode !== null && sslmode !== undefined && sslmode.length > 0 && !VALID_SSLMODES.has(sslmode)
  );
}

/** Read a libpq `PG*` env var, treating empty as unset (pgconn's `parseEnvSettings`). */
function libpqEnv(env: LegacyParseEnv, name: string): string | undefined {
  const value = env(name);
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
 * Resolve a libpq password with pgconn's precedence (`mergeSettings` plus the
 * `config.Password == ""` `.pgpass` fallback, `config.go:264-379`): a password
 * supplied by the connection string — **even an explicit empty one**
 * (`user:@host`, `?password=`, `password=`) — overrides `PGPASSWORD`, because the
 * connection-string settings are merged over the env settings; an absent password
 * falls back to `PGPASSWORD`. Either way, an empty resolved value then falls
 * through to `.pgpass`. `connStringPassword` is `undefined` only when the string
 * did not specify a password key at all. `host`/`port` are the primary host:
 * pgconn keys `.pgpass` off `config.Host` (the first fallback host).
 *
 * `passfile` is the connection string's `passfile=` setting (URL query or DSN
 * keyword), if any. pgconn honors it ahead of `PGPASSFILE`/the default `~/.pgpass`
 * (`config.go:293,369-377`); it is consumed only for password resolution and never
 * emitted as a runtime param (pgconn's `notRuntimeParams`).
 */
function resolveLibpqPassword(
  connStringPassword: string | undefined,
  host: string,
  port: number,
  database: string,
  user: string,
  env: LegacyParseEnv,
  passfile: string | undefined,
): string {
  const resolved = connStringPassword ?? libpqEnv(env, "PGPASSWORD") ?? "";
  return resolved.length > 0
    ? resolved
    : legacyPgpassPassword(host, port, database, user, env, passfile);
}

/**
 * Zip a comma-separated host list with a comma-separated port list into the
 * ordered dial targets, mirroring pgconn's per-host fallback expansion
 * (`config.go:326-362`): hosts and ports are split independently, and a host with
 * no matching port reuses the first port (`ports[0]`). A non-numeric (or empty)
 * port is a `parsePort` error, surfaced as `undefined` so the caller rejects the
 * DSN. `hostString`/`portString` carry the bare hosts and ports only — for a URL,
 * the structural `host:port` segments are pre-split by `parseHostPortSegment`.
 */
function buildLegacyHostList(
  hostString: string,
  portString: string,
): Array<{ host: string; port: number }> | undefined {
  const hosts = hostString.split(",");
  const ports = portString.split(",");
  const list: Array<{ host: string; port: number }> = [];
  for (let i = 0; i < hosts.length; i++) {
    const portRaw = i < ports.length ? ports[i]! : ports[0]!;
    if (!/^\d+$/.test(portRaw)) return undefined;
    list.push({ host: hosts[i]!, port: Number(portRaw) });
  }
  return list;
}

/** Extract a URL's authority (between `://` and the first `/`, `?`, or `#`). */
function legacyUrlAuthority(url: string): string {
  const schemeEnd = url.indexOf("://");
  const rest = schemeEnd === -1 ? url : url.slice(schemeEnd + 3);
  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Split a `host:port,host:port` list on top-level commas, respecting `[ipv6]`. */
function splitHostPortList(value: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments;
}

/** Parse one `host`, `host:port`, `[ipv6]`, or `[ipv6]:port` authority segment. */
function parseHostPortSegment(segment: string): { host: string; port: string } {
  if (segment.startsWith("[")) {
    const close = segment.indexOf("]");
    if (close === -1) return { host: segment, port: "" };
    const after = segment.slice(close + 1);
    return { host: segment.slice(1, close), port: after.startsWith(":") ? after.slice(1) : "" };
  }
  const colon = segment.lastIndexOf(":");
  return colon === -1
    ? { host: segment, port: "" }
    : { host: segment.slice(0, colon), port: segment.slice(colon + 1) };
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
 *
 * `env` supplies the libpq `PG*` fallbacks; pass a lookup that layers the project
 * `.env*` files under the shell env to match Go's `LoadConfig`-before-parse order.
 */
export function parseLegacyConnectionString(
  value: string,
  env: LegacyParseEnv = processEnv,
): LegacyPgConnInput | undefined {
  const trimmed = value.trim();
  // Match pgconn's dispatch (`config.go:236`): only a literal `postgres://` /
  // `postgresql://` prefix is parsed as a URL; everything else is a libpq
  // keyword/value DSN. So a mistyped scheme like `https://host/db` falls through
  // to the DSN parser, which rejects it (no `key=value`) → the caller surfaces a
  // redacted parse error rather than connecting to a bogus host.
  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) {
    return parseUrlConnectionString(value, env);
  }
  return parseKeywordValueDsn(trimmed, env);
}

/** Parse the WHATWG `postgres(ql)://` URL form. */
function parseUrlConnectionString(
  value: string,
  env: LegacyParseEnv,
): LegacyPgConnInput | undefined {
  const trimmed = value.trim();
  // pgconn accepts libpq multi-host failover URLs (`postgres://h1:5432,h2:5433/db`,
  // `config.go:166,326-362`), which WHATWG `new URL()` rejects (the comma'd
  // host:port is not a valid authority). Hand-extract the authority so we can split
  // the host list ourselves, then normalize the URL down to its first host so
  // `new URL()` still parses the userinfo, path, and query exactly as before.
  const authority = legacyUrlAuthority(trimmed);
  // Go's `net/url` splits userinfo from host on the last `@`; literal `@` in a
  // password must be percent-encoded, so the last `@` is the real boundary.
  const atIdx = authority.lastIndexOf("@");
  const userinfoRaw = atIdx === -1 ? "" : authority.slice(0, atIdx);
  const hostPortRaw = atIdx === -1 ? authority : authority.slice(atIdx + 1);
  const segments = splitHostPortList(hostPortRaw);
  const multiHost = segments.length > 1;

  let normalized = trimmed;
  if (multiHost) {
    const authorityStart = trimmed.indexOf("://") + 3;
    const newAuthority =
      atIdx === -1 ? segments[0]! : `${authority.slice(0, atIdx + 1)}${segments[0]!}`;
    normalized =
      trimmed.slice(0, authorityStart) +
      newAuthority +
      trimmed.slice(authorityStart + authority.length);
  }

  let url: URL;
  try {
    url = new URL(normalized);
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
    const user = rawUser.length > 0 ? rawUser : defaultOsUser(env);
    // libpq fills `sslmode` from `PGSSLMODE` when the connection string omits it
    // (pgconn's `parseEnvSettings`), before the TLS-mode default.
    const sslmode = url.searchParams.get("sslmode") ?? libpqEnv(env, "PGSSLMODE") ?? null;
    if (isInvalidSslmode(sslmode)) {
      return undefined;
    }
    // libpq `sslrootcert` (query or `PGSSLROOTCERT`) pins the server CA.
    const sslrootcert =
      url.searchParams.get("sslrootcert") ?? libpqEnv(env, "PGSSLROOTCERT") ?? null;
    const options = url.searchParams.get("options");
    // A `passfile=` query setting points `.pgpass` resolution at a non-default file
    // (pgconn `config.go:293`); a non-empty value wins over `PGPASSFILE`/the default.
    const passfileQuery = url.searchParams.get("passfile");
    const passfile = passfileQuery !== null && passfileQuery.length > 0 ? passfileQuery : undefined;

    // Structural hosts/ports become pgconn's comma-joined `settings["host"]` /
    // `settings["port"]`. WHATWG `URL.hostname` keeps the brackets around an IPv6
    // literal (`[::1]`); Go's `url.Hostname()` returns the unbracketed host (only
    // re-adding brackets when formatting via `ToPostgresURL`), so strip them. For a
    // multi-host URL the per-segment host/port were already split out by hand.
    const structuralHosts = multiHost
      ? segments.map((s) => parseHostPortSegment(s).host).filter((h) => h.length > 0)
      : url.hostname.length > 0
        ? [unbracketIpv6(url.hostname)]
        : [];
    const structuralPorts = multiHost
      ? segments.map((s) => parseHostPortSegment(s).port).filter((p) => p.length > 0)
      : url.port.length > 0
        ? [url.port]
        : [];

    const hostQuery = query.get("host");
    const hostString =
      hostQuery !== null && hostQuery.length > 0
        ? hostQuery
        : structuralHosts.length > 0
          ? structuralHosts.join(",")
          : (libpqEnv(env, "PGHOST") ?? defaultLibpqHost());
    // pgconn merges a `?port=` query setting over the structural port and then
    // parses it, so an explicit query port — even empty (`?port=`) or non-numeric
    // — that is not a valid number is a parse error. A bad `PGPORT` fallback is
    // likewise rejected (`libpqPort` → undefined). `url.port` is always digits.
    const portQuery = query.get("port");
    if (portQuery !== null && !/^\d+$/.test(portQuery)) {
      return undefined;
    }
    let portString: string;
    if (portQuery !== null) {
      portString = portQuery;
    } else if (structuralPorts.length > 0) {
      portString = structuralPorts.join(",");
    } else {
      const envPort = libpqPort(libpqEnv(env, "PGPORT"));
      if (envPort === undefined) return undefined;
      portString = String(envPort);
    }

    const hostList = buildLegacyHostList(hostString, portString);
    if (hostList === undefined || hostList.length === 0) {
      return undefined;
    }
    const primary = hostList[0]!;

    const rawDatabase = queryOrElse("dbname", decodeURIComponent(url.pathname.replace(/^\//, "")));
    // Absent database → PGDATABASE, then the resolved user (libpq default).
    const database = rawDatabase.length > 0 ? rawDatabase : (libpqEnv(env, "PGDATABASE") ?? user);

    // Password precedence (pgconn): the query loop runs last, so `?password=`
    // overrides the userinfo password. A `:` in the raw userinfo marks a present
    // (possibly empty) userinfo password — `user:@host` — which WHATWG `url.password`
    // cannot distinguish from an absent one (`user@host`), so detect it from the
    // raw string. `resolveLibpqPassword` then applies the PGPASSWORD/`.pgpass` rules.
    const connStringPassword = query.has("password")
      ? (query.get("password") ?? "")
      : userinfoRaw.includes(":")
        ? decodeURIComponent(url.password)
        : undefined;
    const password = resolveLibpqPassword(
      connStringPassword,
      primary.host,
      primary.port,
      database,
      user,
      env,
      passfile,
    );
    return {
      host: primary.host,
      port: primary.port,
      user,
      password,
      database,
      ...(hostList.length > 1 ? { fallbacks: hostList.slice(1) } : {}),
      ...(options !== null && options.length > 0 ? { options } : {}),
      ...(sslmode !== null && sslmode.length > 0 ? { sslmode } : {}),
      ...(sslrootcert !== null && sslrootcert.length > 0 ? { sslrootcert } : {}),
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
function parseKeywordValueDsn(value: string, env: LegacyParseEnv): LegacyPgConnInput | undefined {
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
  // A libpq DSN also accepts comma-separated multi-host failover
  // (`host=h1,h2 port=5432,5433`, `config.go:326-362`), zipped by `buildLegacyHostList`.
  const hostString =
    params.get("host") ?? params.get("hostaddr") ?? libpqEnv(env, "PGHOST") ?? defaultLibpqHost();
  // Explicit empty/non-numeric `port=` is a parse error (pgconn's `parsePort`); an
  // absent `port` falls back to `PGPORT` and then the libpq default.
  const portParam = params.get("port");
  let portString: string;
  if (portParam !== undefined) {
    portString = portParam;
  } else {
    const envPort = libpqPort(libpqEnv(env, "PGPORT"));
    if (envPort === undefined) return undefined;
    portString = String(envPort);
  }
  const hostList = buildLegacyHostList(hostString, portString);
  if (hostList === undefined || hostList.length === 0) return undefined;
  const primary = hostList[0]!;
  const user = params.get("user") ?? defaultOsUser(env);
  const database =
    params.get("dbname") ?? libpqEnv(env, "PGDATABASE") ?? (user.length > 0 ? user : "postgres");
  // libpq fills `sslmode` from `PGSSLMODE` when the DSN omits it (pgconn's
  // `parseEnvSettings`), before the TLS-mode default.
  const sslmode = params.get("sslmode") ?? libpqEnv(env, "PGSSLMODE");
  if (isInvalidSslmode(sslmode)) return undefined;
  const sslrootcert = params.get("sslrootcert") ?? libpqEnv(env, "PGSSLROOTCERT");
  const options = params.get("options");
  // A `passfile=` keyword points `.pgpass` resolution at a non-default file
  // (pgconn `config.go:293`); a non-empty value wins over `PGPASSFILE`/the default.
  const passfileParam = params.get("passfile");
  const passfile =
    passfileParam !== undefined && passfileParam.length > 0 ? passfileParam : undefined;
  // Password precedence (pgconn): a `password=` entry — even empty — overrides
  // PGPASSWORD; an empty resolved value then falls through to `.pgpass`.
  const password = resolveLibpqPassword(
    params.has("password") ? params.get("password")! : undefined,
    primary.host,
    primary.port,
    database,
    user,
    env,
    passfile,
  );
  return {
    host: primary.host,
    port: primary.port,
    user,
    password,
    database,
    ...(hostList.length > 1 ? { fallbacks: hostList.slice(1) } : {}),
    ...(options !== undefined && options.length > 0 ? { options } : {}),
    ...(sslmode !== undefined && sslmode.length > 0 ? { sslmode } : {}),
    ...(sslrootcert !== undefined && sslrootcert.length > 0 ? { sslrootcert } : {}),
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
function defaultOsUser(env: LegacyParseEnv): string {
  return env("PGUSER") ?? env("USER") ?? env("USERNAME") ?? "postgres";
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
