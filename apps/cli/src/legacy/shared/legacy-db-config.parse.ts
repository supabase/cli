import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { LegacyPgConnInput } from "./legacy-db-connection.service.ts";
import { legacyPgpassPassword } from "./legacy-pgpass.ts";
import { legacyServiceSettings } from "./legacy-pgservicefile.ts";

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

/** Sentinel for a present-but-non-numeric `connect_timeout` (pgconn parse error). */
const CONNECT_TIMEOUT_INVALID = Symbol("connect-timeout-invalid");

/**
 * Resolve the libpq `connect_timeout` (seconds). `raw` must already have the
 * absent-vs-present distinction made by the caller: `null`/`undefined` means the
 * setting was absent (unset → driver applies Go's 10s/2s default), while any string
 * — including `""` — is a *present* connection-string value. pgconn keeps a present
 * `connect_timeout` and runs `parseConnectTimeoutSetting`, which errors on a
 * non-integer (including empty), so a present non-numeric value returns the failure
 * sentinel. `0` parses to a zero duration (not an error), treated as unset so the
 * default applies. An empty `PGCONNECT_TIMEOUT` env var is dropped by the caller
 * (pgconn ignores empty `PG*` vars), so it never reaches here as `""`.
 */
function libpqConnectTimeout(
  raw: string | null | undefined,
): number | undefined | typeof CONNECT_TIMEOUT_INVALID {
  if (raw === null || raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return CONNECT_TIMEOUT_INVALID;
  const seconds = Number(raw);
  return seconds > 0 ? seconds : undefined;
}

/**
 * Sentinel returned when a `service` is requested but cannot be resolved (missing
 * service file, unknown service, or a malformed file). pgconn fails the whole
 * parse in that case (`config.go:253`), so the caller surfaces a parse error
 * rather than silently connecting to the defaults.
 */
const SERVICE_RESOLUTION_FAILED = Symbol("service-resolution-failed");

/** libpq's default service file (`~/.pg_service.conf`); `PGSERVICEFILE` overrides. */
function defaultServiceFilePath(): string | undefined {
  const home = homedir();
  return home.length > 0 ? join(home, ".pg_service.conf") : undefined;
}

/**
 * Resolve pgservice settings, mirroring pgconn (`config.go:250-256`): when a
 * `service` is set (connection string `service=`/`?service=`, else `PGSERVICE`),
 * read the service file (connection string `servicefile=`/`?servicefile=`, then
 * `PGSERVICEFILE`, then `~/.pg_service.conf`) and return the named section's
 * settings (with `dbname` already remapped to `database`). Returns `undefined`
 * when no service is requested, or the failure sentinel when a requested service
 * cannot be resolved. The resolved settings sit above env/defaults but below the
 * explicit connection-string fields.
 *
 * pgconn records a connection-string `service` key unconditionally and merges it
 * over `PGSERVICE` (`config.go:504,406`), so a *present* connStr `service` (even
 * empty) overrides the env var; an empty service then fails resolution
 * (`GetService("")` → not found → parse error), rather than silently using
 * `PGSERVICE`/defaults. So `connStringService` is `null`/`undefined` only when the
 * key is absent.
 */
function resolveServiceSettings(
  connStringService: string | null | undefined,
  connStringServicefile: string | undefined,
  env: LegacyParseEnv,
): Map<string, string> | typeof SERVICE_RESOLUTION_FAILED | undefined {
  const service =
    connStringService !== null && connStringService !== undefined
      ? connStringService
      : libpqEnv(env, "PGSERVICE");
  if (service === undefined) {
    return undefined;
  }
  // A present-but-empty connString `service=` overrides PGSERVICE and fails
  // resolution in pgconn (`GetService("")` → not found), so reject the parse.
  if (service.length === 0) {
    return SERVICE_RESOLUTION_FAILED;
  }
  // A present connString `servicefile` (even empty) overrides PGSERVICEFILE
  // unconditionally (pgconn `config.go:504,256`); an empty path then fails
  // `ReadServicefile("")` → parse error. Only an absent key falls back to
  // PGSERVICEFILE then the default `~/.pg_service.conf`.
  const servicefile =
    connStringServicefile !== undefined
      ? connStringServicefile
      : (libpqEnv(env, "PGSERVICEFILE") ?? defaultServiceFilePath());
  if (servicefile === undefined || servicefile.length === 0) {
    return SERVICE_RESOLUTION_FAILED;
  }
  return legacyServiceSettings(service, servicefile) ?? SERVICE_RESOLUTION_FAILED;
}

/**
 * A service setting: the raw value (including an intentional empty string) when the
 * key is present, else `undefined`. Unlike env vars, pgconn does **not** empty-skip
 * service settings — `parseServiceSettings` copies them verbatim and `mergeSettings`
 * merges them unconditionally over env (`config.go:401-411` vs the empty-skip in
 * `parseEnvSettings` `config.go:436-441`). So a present-but-empty service value
 * (e.g. `password=` to suppress `PGPASSWORD` → `.pgpass`, or `connect_timeout=` to
 * force a parse error) overrides env. Returning `""` here makes the callers' `??`
 * chains honor that, since `??` preserves the empty string.
 */
function serviceValue(settings: Map<string, string> | undefined, key: string): string | undefined {
  return settings?.get(key);
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
    // pgconn's `parsePort` rejects ports outside 1..65535 (`config.go:784-793`), so
    // `0`/`70000` are parse errors rather than being deferred to the driver/OS. This
    // is the single chokepoint every port path (query, structural, PGPORT) funnels
    // through, matching pgconn's per-host `parsePort` call (`config.go:337`).
    const port = Number(portRaw);
    if (port < 1 || port > 65535) return undefined;
    list.push({ host: hosts[i]!, port });
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
  // pgconn accepts a port-only authority (`postgres://:5433/db`): `net.SplitHostPort`
  // yields an empty host + the port, so the host falls back to PGHOST/default while
  // the port is kept (`config.go:464-488`). WHATWG `new URL()` throws on an empty
  // host with a port, so route that through the same hand-split path as multi-host.
  const firstSegmentHost = parseHostPortSegment(segments[0]!).host;
  const emptyHostAuthority = !multiHost && firstSegmentHost.length === 0 && hostPortRaw.length > 0;
  const useHandSplit = multiHost || emptyHostAuthority;

  let normalized = trimmed;
  if (useHandSplit) {
    const authorityStart = trimmed.indexOf("://") + 3;
    // Substitute a placeholder host so `new URL()` can parse the userinfo/path/query;
    // the real host(s)/port(s) come from the hand-split segments below. A non-empty
    // first segment (multi-host) is reused verbatim; an empty host gets a literal
    // placeholder (never read — structural host/port override it).
    const placeholderHost = firstSegmentHost.length > 0 ? segments[0]! : "placeholder.invalid";
    const newAuthority =
      atIdx === -1 ? placeholderHost : `${authority.slice(0, atIdx + 1)}${placeholderHost}`;
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
    // pgconn's `parseURLSettings` runs the query-param loop **last** and sets
    // `settings[k] = v` unconditionally (`config.go:499-505`), so a libpq URL query
    // setting (`?host=`, `?port=`, `?dbname=`, `?user=`, `?password=`) overrides the
    // structural userinfo/host/path **even when empty** — a present-but-empty
    // `?dbname=` yields an empty database, distinct from an absent param. So branch
    // on `query.has(key)` (present, even ""), not on a non-empty check. `searchParams`
    // already percent-decodes, so query values are used verbatim.

    // A URL that omits a field falls back to the libpq `PG*` env vars and then the
    // libpq defaults, matching pgconn's
    // `mergeSettings(defaultSettings, envSettings, connStringSettings)`.
    // Resolve a pgservice (`?service=`/`PGSERVICE`) before applying defaults; its
    // settings sit above env/defaults but below the explicit URL fields.
    const serviceSettings = resolveServiceSettings(
      query.get("service"),
      query.get("servicefile") ?? undefined,
      env,
    );
    if (serviceSettings === SERVICE_RESOLUTION_FAILED) {
      return undefined;
    }
    const svc = (key: string): string | undefined => serviceValue(serviceSettings, key);

    // A present `?user=` (even empty) overrides the userinfo; only an absent param
    // falls back to userinfo → service → OS user.
    const userQuery = query.get("user");
    const structuralUser = decodeURIComponent(url.username);
    const user =
      userQuery !== null
        ? userQuery
        : structuralUser.length > 0
          ? structuralUser
          : (svc("user") ?? defaultOsUser(env));
    // libpq fills `sslmode` from the service, then `PGSSLMODE`, when the connection
    // string omits it (pgconn's merge order), before the TLS-mode default.
    const sslmode =
      url.searchParams.get("sslmode") ?? svc("sslmode") ?? libpqEnv(env, "PGSSLMODE") ?? null;
    if (isInvalidSslmode(sslmode)) {
      return undefined;
    }
    // libpq `sslrootcert` (query, service, or `PGSSLROOTCERT`) pins the server CA.
    const sslrootcert =
      url.searchParams.get("sslrootcert") ??
      svc("sslrootcert") ??
      libpqEnv(env, "PGSSLROOTCERT") ??
      null;
    const options = url.searchParams.get("options") ?? svc("options") ?? null;
    // A `passfile=` setting (query or service) points `.pgpass` resolution at a
    // non-default file (pgconn `config.go:293`); non-empty wins over `PGPASSFILE`.
    // A present `passfile=` (even empty) overrides PGPASSFILE/default; a present-empty
    // value then resolves to no `.pgpass` (pgconn's `ReadPassfile("")` fails) →
    // empty password. Only an absent param falls back to the service value.
    const passfileQuery = url.searchParams.get("passfile");
    const passfile = passfileQuery !== null ? passfileQuery : svc("passfile");
    // libpq `connect_timeout` (query, service, or `PGCONNECT_TIMEOUT`). A *present*
    // query value (even empty) overrides service/env and is parsed (empty → error,
    // pgconn's `parseConnectTimeoutSetting`); only an absent query param falls back.
    const connectTimeoutRaw = url.searchParams.has("connect_timeout")
      ? url.searchParams.get("connect_timeout")
      : (svc("connect_timeout") ?? libpqEnv(env, "PGCONNECT_TIMEOUT"));
    const connectTimeout = libpqConnectTimeout(connectTimeoutRaw);
    if (connectTimeout === CONNECT_TIMEOUT_INVALID) {
      return undefined;
    }

    // Structural hosts/ports become pgconn's comma-joined `settings["host"]` /
    // `settings["port"]`. WHATWG `URL.hostname` keeps the brackets around an IPv6
    // literal (`[::1]`); Go's `url.Hostname()` returns the unbracketed host (only
    // re-adding brackets when formatting via `ToPostgresURL`), so strip them. For a
    // multi-host URL the per-segment host/port were already split out by hand.
    const structuralHosts = useHandSplit
      ? segments.map((s) => parseHostPortSegment(s).host).filter((h) => h.length > 0)
      : url.hostname.length > 0
        ? [unbracketIpv6(url.hostname)]
        : [];
    const structuralPorts = useHandSplit
      ? segments.map((s) => parseHostPortSegment(s).port).filter((p) => p.length > 0)
      : url.port.length > 0
        ? [url.port]
        : [];

    // A present `?host=` (even empty) overrides the structural host verbatim
    // (pgconn copies it into `settings["host"]` unconditionally, `config.go:499-505`,
    // and an empty value is a literal empty host — it does NOT re-fall-back to
    // PGHOST/default). Only an absent param falls back to structural → service →
    // PGHOST → default.
    const hostQuery = query.get("host");
    const hostString =
      hostQuery !== null
        ? hostQuery
        : structuralHosts.length > 0
          ? structuralHosts.join(",")
          : (svc("host") ?? libpqEnv(env, "PGHOST") ?? defaultLibpqHost());
    // pgconn copies a `?port=` query value verbatim into `settings["port"]` and the
    // fallback builder splits it on commas, parsing each segment (`config.go:326-340`),
    // so a multi-host URL may carry a comma-separated port list (`?port=5432,5433`).
    // Reject only an empty `?port=` or a segment that is not numeric; `buildLegacyHostList`
    // then zips and range-checks each. `url.port` is always digits.
    const portQuery = query.get("port");
    if (
      portQuery !== null &&
      (portQuery.length === 0 || portQuery.split(",").some((p) => !/^\d+$/.test(p)))
    ) {
      return undefined;
    }
    let portString: string;
    if (portQuery !== null) {
      portString = portQuery;
    } else if (structuralPorts.length > 0) {
      portString = structuralPorts.join(",");
    } else {
      const envPort = libpqPort(svc("port") ?? libpqEnv(env, "PGPORT"));
      if (envPort === undefined) return undefined;
      portString = String(envPort);
    }

    const hostList = buildLegacyHostList(hostString, portString);
    if (hostList === undefined || hostList.length === 0) {
      return undefined;
    }
    const primary = hostList[0]!;

    // A present `?dbname=` (even empty) overrides the URL path verbatim (pgconn
    // connects with an empty database — there is no `database` default). pgconn also
    // accepts `database` as an alias for `dbname` (its query/DSN `nameMap`,
    // `config.go:495-497`), copied into `settings["database"]`; prefer `dbname` when
    // both appear (Go's map iteration has no defined precedence). Only an absent
    // param falls back to the path → service → PGDATABASE → resolved user.
    const dbnameQuery = query.get("dbname") ?? query.get("database");
    const structuralDb = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const database =
      dbnameQuery !== null
        ? dbnameQuery
        : structuralDb.length > 0
          ? structuralDb
          : (svc("database") ?? libpqEnv(env, "PGDATABASE") ?? user);

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
    // Service password sits below the connection string but above PGPASSWORD/.pgpass.
    // An explicit (even empty) connection-string password still wins (`?? ""`).
    const password = resolveLibpqPassword(
      connStringPassword ?? svc("password"),
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
      ...(connectTimeout !== undefined ? { connectTimeoutSeconds: connectTimeout } : {}),
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
    // Value: single-quoted (with `\` escapes) or bare (until whitespace). pgconn's
    // `parseDSNSettings` unescapes **only** `\\`→`\` and `\'`→`'`; a backslash before
    // any other char is preserved (`config.go:539-566`), so Windows cert paths like
    // `C:\certs\root.pem` and literal `\n` in a password survive intact. (A `\'`
    // inside a quoted value is data, not the closing quote.)
    const isEscapedChar = (j: number): boolean =>
      value[j] === "\\" && j + 1 < n && (value[j + 1] === "\\" || value[j + 1] === "'");
    let val = "";
    if (value[i] === "'") {
      i++;
      // An escaped `\'` is consumed in the body, so a bare `'` is the terminator.
      while (i < n && value[i] !== "'") {
        if (isEscapedChar(i)) i++;
        val += value[i];
        i++;
      }
      if (value[i] !== "'") return undefined;
      i++;
    } else {
      while (i < n && !isSpace(value[i]!)) {
        // pgconn's unquoted scan advances past any `\`, then errors with
        // "invalid backslash" when the escape has no following char
        // (`config.go:539-543`), so a lone trailing backslash is a parse error.
        if (!isEscapedChar(i) && value[i] === "\\" && i + 1 >= n) return undefined;
        if (isEscapedChar(i)) i++;
        val += value[i];
        i++;
      }
    }
    // pgconn rejects an empty keyword with "invalid dsn" (`config.go:578-580`); a
    // leading `=value` or whitespace-only key must fail, not be silently dropped.
    // (Reachable only after a `=` was consumed, so this is exactly the empty-key case.)
    if (key.length === 0) return undefined;
    // pgconn remaps `dbname`→`database` at parse time (`config.go:574-582`), so both
    // aliases share one settings slot and the last occurrence in the DSN wins.
    params.set(key === "dbname" ? "database" : key, val);
  }
  // Omitted fields fall back to libpq `PG*` env vars and then the libpq defaults,
  // matching pgconn's `mergeSettings(defaultSettings, envSettings, connStringSettings)`.
  // A libpq DSN also accepts comma-separated multi-host failover
  // (`host=h1,h2 port=5432,5433`, `config.go:326-362`), zipped by `buildLegacyHostList`.
  // Resolve a pgservice (`service=`/`PGSERVICE`); its settings sit above
  // env/defaults but below the explicit DSN keywords.
  const serviceSettings = resolveServiceSettings(
    params.get("service"),
    params.get("servicefile"),
    env,
  );
  if (serviceSettings === SERVICE_RESOLUTION_FAILED) return undefined;
  const svc = (key: string): string | undefined => serviceValue(serviceSettings, key);

  // pgconn v1.14.3 has no `hostaddr` support: it stores `hostaddr` only as a runtime
  // param and builds `config.Host` solely from `settings["host"]` (`config.go:326,364`),
  // so a `hostaddr`-only DSN dials `defaultHost()` (`defaults.go:15`), never the address.
  // Don't use `hostaddr` as a host fallback (it would dial a different endpoint than Go).
  const hostString =
    params.get("host") ?? svc("host") ?? libpqEnv(env, "PGHOST") ?? defaultLibpqHost();
  // Explicit empty/non-numeric `port=` is a parse error (pgconn's `parsePort`); an
  // absent `port` falls back to the service, then `PGPORT`, then the libpq default.
  const portParam = params.get("port");
  let portString: string;
  if (portParam !== undefined) {
    portString = portParam;
  } else {
    const envPort = libpqPort(svc("port") ?? libpqEnv(env, "PGPORT"));
    if (envPort === undefined) return undefined;
    portString = String(envPort);
  }
  const hostList = buildLegacyHostList(hostString, portString);
  if (hostList === undefined || hostList.length === 0) return undefined;
  const primary = hostList[0]!;
  const user = params.get("user") ?? svc("user") ?? defaultOsUser(env);
  // `dbname` was remapped to `database` at parse time (last-wins alias), so read
  // only `database` here. A present value (even empty) overrides service/env.
  const database =
    params.get("database") ??
    svc("database") ??
    libpqEnv(env, "PGDATABASE") ??
    (user.length > 0 ? user : "postgres");
  // libpq fills `sslmode` from the service, then `PGSSLMODE`, when the DSN omits it
  // (pgconn's merge order), before the TLS-mode default.
  const sslmode = params.get("sslmode") ?? svc("sslmode") ?? libpqEnv(env, "PGSSLMODE");
  if (isInvalidSslmode(sslmode)) return undefined;
  const sslrootcert =
    params.get("sslrootcert") ?? svc("sslrootcert") ?? libpqEnv(env, "PGSSLROOTCERT");
  const options = params.get("options") ?? svc("options");
  // A `passfile=` setting (keyword or service) points `.pgpass` resolution at a
  // non-default file (pgconn `config.go:293`); non-empty wins over `PGPASSFILE`.
  // A present `passfile=` (even empty) overrides PGPASSFILE/default (see URL branch).
  const passfileParam = params.get("passfile");
  const passfile = passfileParam !== undefined ? passfileParam : svc("passfile");
  // libpq `connect_timeout` (keyword, service, or `PGCONNECT_TIMEOUT`). A *present*
  // keyword (even empty) overrides service/env and is parsed (empty → error); only
  // an absent keyword falls back.
  const connectTimeoutRaw = params.has("connect_timeout")
    ? params.get("connect_timeout")!
    : (svc("connect_timeout") ?? libpqEnv(env, "PGCONNECT_TIMEOUT"));
  const connectTimeout = libpqConnectTimeout(connectTimeoutRaw);
  if (connectTimeout === CONNECT_TIMEOUT_INVALID) return undefined;
  // Password precedence (pgconn): a `password=` entry — even empty — overrides the
  // service and PGPASSWORD; an empty resolved value then falls through to `.pgpass`.
  const password = resolveLibpqPassword(
    params.has("password") ? params.get("password")! : svc("password"),
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
    ...(connectTimeout !== undefined ? { connectTimeoutSeconds: connectTimeout } : {}),
  };
}

/**
 * libpq's default user when the connection string omits one. Mirrors `pgconn`'s
 * `mergeSettings(defaultSettings, envSettings, connStringSettings)`
 * (`config.go:249`): `PGUSER` (an env setting) takes priority over the OS account
 * (`defaultSettings` → `user.Current()`), while an explicit `user=`/userinfo in
 * the connection string still wins over both (handled by the callers). The final
 * `"postgres"` guard covers minimal environments where neither is available.
 *
 * pgconn ignores **empty** `PG*` env vars (`parseEnvSettings` only records a value
 * when non-empty, `config.go:436-441`), so an empty `PGUSER` falls through to the OS
 * account. The OS account is `user.Current().Username` (`defaults.go:21-23`) — the
 * passwd entry for the effective uid, **not** the `$USER`/`$USERNAME` env vars (those
 * are never consulted by pgconn; only `PGUSER` is an env override). Node's
 * `os.userInfo().username` is the faithful analogue; it can throw when there is no
 * passwd entry, mirroring Go's ignored-error path → the `"postgres"` guard.
 */
function osAccountUsername(): string | undefined {
  try {
    const name = userInfo().username;
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function defaultOsUser(env: LegacyParseEnv): string {
  return libpqEnv(env, "PGUSER") ?? osAccountUsername() ?? "postgres";
}

/**
 * Mask the password in a connection string for safe inclusion in error output
 * (CWE-209): a malformed `--db-url` often still carries a secret. Pure string
 * replacement (not `URL.toString()`, which would percent-encode the literal
 * `[REDACTED]`) covers URL userinfo (`://user:secret@`), the malformed-but-
 * credential-bearing URL case, and libpq keyword/value DSNs (`password=…` /
 * `password='…'`).
 *
 * The URL-userinfo password span is greedy (`.*`) so it consumes a literal `@` or
 * `/` inside a hand-typed password; the lookahead anchors the redaction boundary on
 * the **last** `@` before the authority terminator (`/`, `?`, `#`, or end), so
 * `postgres://user:p@ss/word@host/db` redacts the whole password rather than leaking
 * a fragment. Where it cannot disambiguate it over-redacts, which is the safe
 * direction for CWE-209 (over-redaction is fine; leaking is the bug).
 *
 * The keyword-DSN `password=` branch matches a properly closed `'…'` value first
 * (preserving any trailing `key=value` pairs), then an **unterminated** opening
 * quote through end-of-string (a malformed `password='secret with spaces …` whose
 * value has no closing quote — redact to EOL rather than leaking past the first
 * space), then a bare unquoted token.
 */
export function redactLegacyConnectionString(value: string): string {
  return value
    .replace(/(:\/\/[^:@/?#]*:).*(@)(?=[^@/?#]*(?:[/?#]|$))/, "$1[REDACTED]$2")
    .replace(/(\bpassword\s*=\s*)('(?:[^'\\]|\\.)*'|'.*$|\S+)/i, "$1[REDACTED]");
}
