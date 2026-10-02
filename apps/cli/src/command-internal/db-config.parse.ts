import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { getDomain } from "tldts";
import type { PgConnInput } from "./db-connection.service.ts";
import { pgpassPassword } from "./pgpass.ts";
import { pgServiceSettings } from "./pgservicefile.ts";

/** The default direct Postgres port. */
const DIRECT_PORT = 5432;

/**
 * Environment lookup used for libpq `PG*` fallbacks. Injected so the resolver can layer the
 * project `.env*` files under the shell environment before reading
 * `PGHOST`/`PGPASSWORD`/`PGSSLMODE`/…. Defaults to `process.env` so the pure call sites (and the
 * pooler path, whose connection string is fully specified) keep their existing behavior.
 */
export type ParseEnv = (name: string) => string | undefined;

const processEnv: ParseEnv = (name) => process.env[name];

/**
 * The `sslmode` values libpq accepts; any other value is a parse error
 * (`"sslmode is invalid"`), so the DSN is rejected rather than treated as `prefer`.
 */
const VALID_SSLMODES = new Set([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

// Connection settings that are not forwarded to the server as startup runtime params.
// Everything else in a DSN (e.g. `search_path`, `statement_timeout`, `application_name`) is a
// runtime param re-appended to the connection URL. `options` is technically a runtime param but
// is carried as its own field here (Supavisor pooler routing), so it's excluded here to avoid
// emitting it twice. `dbname`/`hostaddr` are structural and handled separately.
const NOT_RUNTIME_PARAMS = new Set([
  "host",
  "hostaddr",
  "port",
  "database",
  "dbname",
  "user",
  "password",
  "passfile",
  "connect_timeout",
  "sslmode",
  "sslkey",
  "sslcert",
  "sslrootcert",
  "sslpassword",
  "sslsni",
  "sslnegotiation",
  "krbspn",
  "krbsrvname",
  "gssencmode",
  "target_session_attrs",
  "service",
  "servicefile",
  "options",
]);

/**
 * Collect the startup runtime params: every key not in `NOT_RUNTIME_PARAMS` is forwarded to the
 * server (and so to pg-delta). Built from the fully merged settings, so a `pg_service.conf`
 * entry's `search_path` or `PGAPPNAME` → `application_name` are runtime params too, not just the
 * connection-string query. Merged in libpq precedence (env → service → connString, last write
 * wins). Returns `undefined` when there are none.
 */
function collectRuntimeParams(
  connStringEntries: Iterable<readonly [string, string]>,
  serviceSettings: Map<string, string> | undefined,
  env: ParseEnv,
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  const add = (key: string, value: string): void => {
    if (!NOT_RUNTIME_PARAMS.has(key)) params[key] = value;
  };
  // env: the only PG* var mapped into runtime params is PGAPPNAME → application_name (the rest
  // are connection settings). Empty is treated as unset.
  const appName = libpqEnv(env, "PGAPPNAME");
  if (appName !== undefined) add("application_name", appName);
  // service: every service key is copied verbatim into the merged settings, so its
  // non-connection keys (search_path, application_name, …) are runtime params.
  if (serviceSettings !== undefined) {
    for (const [key, value] of serviceSettings) add(key, value);
  }
  // connString: highest precedence (overrides env/service).
  for (const [key, value] of connStringEntries) add(key, value);
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Resolve libpq client-certificate settings (`sslcert`/`sslkey`/`sslpassword`) with the
 * connection-string → service → `PG*` precedence. `sslcert`+`sslkey` load the client TLS
 * certificate and require both or neither; `sslpassword` decrypts an encrypted key. Returns
 * `"invalid"` when exactly one of cert/key is present.
 */
function resolveClientCert(
  get: (key: string) => string | null | undefined,
  svc: (key: string) => string | undefined,
  env: ParseEnv,
): { sslcert?: string; sslkey?: string; sslpassword?: string } | "invalid" {
  const pick = (key: string, pg: string): string | undefined => {
    const value = get(key) ?? svc(key) ?? libpqEnv(env, pg);
    return value !== null && value !== undefined && value.length > 0 ? value : undefined;
  };
  const sslcert = pick("sslcert", "PGSSLCERT");
  const sslkey = pick("sslkey", "PGSSLKEY");
  const sslpassword = pick("sslpassword", "PGSSLPASSWORD");
  if ((sslcert === undefined) !== (sslkey === undefined)) return "invalid";
  if (sslcert === undefined) return {};
  return { sslcert, sslkey, ...(sslpassword !== undefined ? { sslpassword } : {}) };
}

/** Whether a resolved sslmode is present and not one libpq accepts. */
function isInvalidSslmode(sslmode: string | null | undefined): boolean {
  return (
    sslmode !== null && sslmode !== undefined && sslmode.length > 0 && !VALID_SSLMODES.has(sslmode)
  );
}

/** Read a libpq `PG*` env var, treating empty as unset. */
function libpqEnv(env: ParseEnv, name: string): string | undefined {
  const value = env(name);
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * libpq's default host when the connection string omits one: on non-Windows, the first existing
 * common unix-socket directory, else `localhost`; Windows always uses `localhost`. `PGHOST`
 * (applied by the callers) takes priority over this.
 */
function defaultLibpqHost(): string {
  if (process.platform === "win32") return "localhost";
  for (const candidate of ["/var/run/postgresql", "/private/tmp", "/tmp"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "localhost";
}

/**
 * Resolve the libpq `PGPORT` fallback. An unset/empty value uses the default 5432, a numeric
 * value is used, and a present non-numeric value returns `undefined` so the caller rejects the
 * DSN as an invalid port rather than defaulting.
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
 * Resolve the libpq `connect_timeout` (seconds). `raw` must already have the absent-vs-present
 * distinction made by the caller: `null`/`undefined` means the setting was absent (unset → the
 * driver applies its own default), while any string — including `""` — is a present
 * connection-string value, parsed as an integer; a present non-numeric value returns the failure
 * sentinel. `0` parses to a zero duration, treated as unset so the default applies. An empty
 * `PGCONNECT_TIMEOUT` env var is dropped by the caller, so it never reaches here as `""`.
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
 * Sentinel returned when a `service` is requested but cannot be resolved (missing service file,
 * unknown service, or a malformed file), so the caller surfaces a parse error rather than
 * silently connecting to the defaults.
 */
const SERVICE_RESOLUTION_FAILED = Symbol("service-resolution-failed");

/** libpq's default service file (`~/.pg_service.conf`); `PGSERVICEFILE` overrides. */
function defaultServiceFilePath(): string | undefined {
  const home = homedir();
  return home.length > 0 ? join(home, ".pg_service.conf") : undefined;
}

/**
 * Resolve pgservice settings: when a `service` is set (connection string `service=`/`?service=`,
 * else `PGSERVICE`), read the service file (connection string
 * `servicefile=`/`?servicefile=`, then `PGSERVICEFILE`, then `~/.pg_service.conf`) and return the
 * named section's settings (with `dbname` already remapped to `database`). Returns `undefined`
 * when no service is requested, or the failure sentinel when a requested service cannot be
 * resolved. The resolved settings sit above env/defaults but below the explicit
 * connection-string fields.
 *
 * A present connection-string `service` (even empty) overrides the env var, and an empty service
 * then fails resolution rather than silently falling back to `PGSERVICE`/defaults, so
 * `connStringService` is `null`/`undefined` only when the key is absent.
 */
function resolveServiceSettings(
  connStringService: string | null | undefined,
  connStringServicefile: string | undefined,
  env: ParseEnv,
): Map<string, string> | typeof SERVICE_RESOLUTION_FAILED | undefined {
  const service =
    connStringService !== null && connStringService !== undefined
      ? connStringService
      : libpqEnv(env, "PGSERVICE");
  if (service === undefined) {
    return undefined;
  }
  // A present-but-empty connString `service=` overrides PGSERVICE and fails resolution, so
  // reject the parse.
  if (service.length === 0) {
    return SERVICE_RESOLUTION_FAILED;
  }
  // A present connString `servicefile` (even empty) overrides PGSERVICEFILE unconditionally; an
  // empty path then fails resolution. Only an absent key falls back to PGSERVICEFILE then the
  // default `~/.pg_service.conf`.
  const servicefile =
    connStringServicefile !== undefined
      ? connStringServicefile
      : (libpqEnv(env, "PGSERVICEFILE") ?? defaultServiceFilePath());
  if (servicefile === undefined || servicefile.length === 0) {
    return SERVICE_RESOLUTION_FAILED;
  }
  return pgServiceSettings(service, servicefile) ?? SERVICE_RESOLUTION_FAILED;
}

/**
 * A service setting: the raw value (including an intentional empty string) when the key is
 * present, else `undefined`. Unlike env vars, service settings are not empty-skipped, so a
 * present-but-empty value (e.g. `password=` to suppress `PGPASSWORD` → `.pgpass`, or
 * `connect_timeout=` to force a parse error) overrides env. Returning `""` here makes the
 * callers' `??` chains honor that, since `??` preserves the empty string.
 */
function serviceValue(settings: Map<string, string> | undefined, key: string): string | undefined {
  return settings?.get(key);
}

/**
 * Resolve a libpq password with libpq's precedence plus the `.pgpass` fallback: a password
 * supplied by the connection string — even an explicit empty one (`user:@host`, `?password=`,
 * `password=`) — overrides `PGPASSWORD`, since connection-string settings merge over env; an
 * absent password falls back to `PGPASSWORD`. Either way, an empty resolved value falls through
 * to `.pgpass`. `connStringPassword` is `undefined` only when the string didn't specify a
 * password key at all. `host`/`port` key `.pgpass` off the primary (first fallback) host.
 *
 * `passfile` is the connection string's `passfile=` setting (URL query or DSN keyword), if any.
 * It's honored ahead of `PGPASSFILE`/the default `~/.pgpass`; consumed only for password
 * resolution, never emitted as a runtime param.
 */
function resolveLibpqPassword(
  connStringPassword: string | undefined,
  host: string,
  port: number,
  database: string,
  user: string,
  env: ParseEnv,
  passfile: string | undefined,
): string {
  const resolved = connStringPassword ?? libpqEnv(env, "PGPASSWORD") ?? "";
  return resolved.length > 0 ? resolved : pgpassPassword(host, port, database, user, env, passfile);
}

/**
 * Zip a comma-separated host list with a comma-separated port list into the ordered dial
 * targets: hosts and ports are split independently, and a host with no matching port reuses the
 * first port. A non-numeric (or empty) port is surfaced as `undefined` so the caller rejects the
 * DSN. `hostString`/`portString` carry the bare hosts and ports only — for a URL, the structural
 * `host:port` segments are pre-split by `parseHostPortSegment`.
 */
function buildHostList(
  hostString: string,
  portString: string,
): Array<{ host: string; port: number }> | undefined {
  const hosts = hostString.split(",");
  const ports = portString.split(",");
  const list: Array<{ host: string; port: number }> = [];
  for (let i = 0; i < hosts.length; i++) {
    const portRaw = i < ports.length ? ports[i]! : ports[0]!;
    if (!/^\d+$/.test(portRaw)) return undefined;
    // Ports outside 1..65535 are parse errors rather than being deferred to the driver/OS. This
    // is the single chokepoint every port path (query, structural, PGPORT) funnels through.
    const port = Number(portRaw);
    if (port < 1 || port > 65535) return undefined;
    list.push({ host: hosts[i]!, port });
  }
  return list;
}

/** Extract a URL's authority (between `://` and the first `/`, `?`, or `#`). */
function urlAuthority(url: string): string {
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
 * Parse a Postgres connection string into a `PgConnInput`. Accepts both the WHATWG
 * `postgres(ql)://…` URL form and the libpq keyword/value DSN form (`host=… dbname=… user=…`,
 * including unix-socket paths). Returns `undefined` on any malformed input so callers can
 * surface a redacted parse error instead of crashing with an unhandled defect.
 *
 * `sslmode` and the libpq `options` startup parameter are preserved: `options` carries the
 * legacy Supavisor `?options=reference=<ref>` tenant routing, and `sslmode` controls TLS.
 *
 * `env` supplies the libpq `PG*` fallbacks; pass a lookup that layers the project `.env*` files
 * under the shell env so they apply before the parse.
 */
export function parseConnectionString(
  value: string,
  env: ParseEnv = processEnv,
): PgConnInput | undefined {
  const trimmed = value.trim();
  // Only a literal `postgres://`/`postgresql://` prefix is parsed as a URL; everything else is
  // a libpq keyword/value DSN. A mistyped scheme like `https://host/db` falls through to the DSN
  // parser, which rejects it (no `key=value`) rather than connecting to a bogus host.
  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) {
    return parseUrlConnectionString(value, env);
  }
  return parseKeywordValueDsn(trimmed, env);
}

/** Layers a project `.env*` lookup under the shell environment: shell presence wins over the project file. */
export function layeredParseEnv(projectEnv: Readonly<Record<string, string>>): ParseEnv {
  return (name) => process.env[name] ?? projectEnv[name];
}

export type PoolerConfigResult =
  | { readonly _tag: "ok"; readonly conn: PgConnInput }
  | { readonly _tag: "invalid"; readonly reason: string };

/**
 * Parse + validate a Supabase transaction-pooler URL: strip the dashboard password placeholder,
 * require the project ref in the tenant user/options, verify the pooler domain belongs to the
 * active profile, and force transaction-pooler port 5432.
 */
export function poolerConfigFromConnectionString(
  ref: string,
  connectionString: string,
  expectedPoolerHost: string,
): PoolerConfigResult {
  const sanitized = connectionString.replaceAll("[YOUR-PASSWORD]", "");
  const parsed = parseConnectionString(sanitized);
  if (parsed === undefined) {
    return { _tag: "invalid", reason: "failed to parse pooler URL" };
  }

  const optionsParam = parsed.options ?? "";
  const dotIndex = parsed.user.indexOf(".");
  if (dotIndex === -1) {
    for (const option of optionsParam.split(",")) {
      const separatorIndex = option.indexOf("=");
      const key = separatorIndex === -1 ? option : option.slice(0, separatorIndex);
      const value = separatorIndex === -1 ? undefined : option.slice(separatorIndex + 1);
      if (key === "reference" && value !== undefined && value !== ref) {
        return { _tag: "invalid", reason: `Pooler options does not match project ref: ${ref}` };
      }
    }
  } else if (parsed.user.slice(dotIndex + 1) !== ref) {
    return { _tag: "invalid", reason: `Pooler username does not match project ref: ${ref}` };
  }

  const domain = getDomain(parsed.host);
  if (domain === null) {
    return { _tag: "invalid", reason: "failed to parse pooler TLD" };
  }
  if (expectedPoolerHost.length > 0 && expectedPoolerHost.toLowerCase() !== domain.toLowerCase()) {
    return {
      _tag: "invalid",
      reason: `Pooler domain does not belong to current profile: ${domain}`,
    };
  }

  return {
    _tag: "ok",
    conn: {
      ...parsed,
      port: DIRECT_PORT,
      ...(optionsParam.length > 0 ? { options: optionsParam } : {}),
    },
  };
}

/** Parse the WHATWG `postgres(ql)://` URL form. */
function parseUrlConnectionString(value: string, env: ParseEnv): PgConnInput | undefined {
  const trimmed = value.trim();
  // libpq accepts multi-host failover URLs (`postgres://h1:5432,h2:5433/db`), which WHATWG
  // `new URL()` rejects (the comma'd host:port is not a valid authority). Hand-extract the
  // authority so we can split the host list ourselves, then normalize the URL down to its first
  // host so `new URL()` still parses the userinfo, path, and query exactly as before.
  const authority = urlAuthority(trimmed);
  // Userinfo splits from host on the last `@`; a literal `@` in a password must be
  // percent-encoded, so the last `@` is the real boundary.
  const atIdx = authority.lastIndexOf("@");
  const userinfoRaw = atIdx === -1 ? "" : authority.slice(0, atIdx);
  const hostPortRaw = atIdx === -1 ? authority : authority.slice(atIdx + 1);
  const segments = splitHostPortList(hostPortRaw);
  const multiHost = segments.length > 1;
  // libpq accepts a port-only authority (`postgres://:5433/db`): an empty host + the port, with
  // the host falling back to PGHOST/default while the port is kept. WHATWG `new URL()` throws on
  // an empty host with a port, so route that through the same hand-split path as multi-host.
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
    // Query-param settings are applied last and unconditionally, so a libpq URL query setting
    // (`?host=`, `?port=`, `?dbname=`, `?user=`, `?password=`) overrides the structural
    // userinfo/host/path even when empty — a present-but-empty `?dbname=` yields an empty
    // database, distinct from an absent param. So branch on `query.has(key)` (present, even ""),
    // not on a non-empty check. `searchParams` already percent-decodes, so query values are used
    // verbatim.

    // A URL that omits a field falls back to the libpq `PG*` env vars and then the libpq
    // defaults. Resolve a pgservice (`?service=`/`PGSERVICE`) before applying defaults; its
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
    // libpq fills `sslmode` from the service, then `PGSSLMODE`, when the connection string
    // omits it, before the TLS-mode default.
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
    // libpq client cert (query, service, or PGSSLCERT/PGSSLKEY/PGSSLPASSWORD); both or neither,
    // else this is a parse error.
    const clientCert = resolveClientCert((key) => url.searchParams.get(key), svc, env);
    if (clientCert === "invalid") {
      return undefined;
    }
    const options = url.searchParams.get("options") ?? svc("options") ?? null;
    // Every other query setting (e.g. search_path, statement_timeout) is a startup runtime
    // param forwarded to the server / pg-delta.
    const runtimeParams = collectRuntimeParams(query, serviceSettings, env);
    // A `passfile=` setting (query or service) points `.pgpass` resolution at a non-default
    // file; a present `passfile=` (even empty) overrides PGPASSFILE/default, and a present-empty
    // value then resolves to no `.pgpass` → empty password. Only an absent param falls back to
    // the service value.
    const passfileQuery = url.searchParams.get("passfile");
    const passfile = passfileQuery !== null ? passfileQuery : svc("passfile");
    // libpq `connect_timeout` (query, service, or `PGCONNECT_TIMEOUT`). A present query value
    // (even empty) overrides service/env and is parsed (empty → error); only an absent query
    // param falls back.
    const connectTimeoutRaw = url.searchParams.has("connect_timeout")
      ? url.searchParams.get("connect_timeout")
      : (svc("connect_timeout") ?? libpqEnv(env, "PGCONNECT_TIMEOUT"));
    const connectTimeout = libpqConnectTimeout(connectTimeoutRaw);
    if (connectTimeout === CONNECT_TIMEOUT_INVALID) {
      return undefined;
    }

    // Structural hosts/ports become comma-joined `host`/`port` settings. WHATWG `URL.hostname`
    // keeps the brackets around an IPv6 literal (`[::1]`), so strip them before rejoining. For a
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

    // A present `?host=` (even empty) overrides the structural host verbatim, and an empty
    // value is a literal empty host — it does not fall back to PGHOST/default. Only an absent
    // param falls back to structural → service → PGHOST → default.
    const hostQuery = query.get("host");
    const hostString =
      hostQuery !== null
        ? hostQuery
        : structuralHosts.length > 0
          ? structuralHosts.join(",")
          : (svc("host") ?? libpqEnv(env, "PGHOST") ?? defaultLibpqHost());
    // A `?port=` query value is copied verbatim, and a multi-host URL may carry a
    // comma-separated port list (`?port=5432,5433`). Reject only an empty `?port=` or a segment
    // that is not numeric; `buildHostList` then zips and range-checks each. `url.port` is always
    // digits.
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

    const hostList = buildHostList(hostString, portString);
    if (hostList === undefined || hostList.length === 0) {
      return undefined;
    }
    const primary = hostList[0]!;

    // A present `?dbname=` (even empty) overrides the URL path verbatim — connecting with an
    // empty database, since there's no `database` default. `database` is also accepted as an
    // alias for `dbname`; prefer `dbname` when both appear. Only an absent param falls back to
    // the path → service → PGDATABASE → resolved user.
    const dbnameQuery = query.get("dbname") ?? query.get("database");
    const structuralDb = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const database =
      dbnameQuery !== null
        ? dbnameQuery
        : structuralDb.length > 0
          ? structuralDb
          : (svc("database") ?? libpqEnv(env, "PGDATABASE") ?? user);

    // Password precedence: the query is applied last, so `?password=` overrides the userinfo
    // password. A `:` in the raw userinfo marks a present (possibly empty) userinfo password —
    // `user:@host` — which WHATWG `url.password` cannot distinguish from an absent one
    // (`user@host`), so detect it from the raw string. `resolveLibpqPassword` then applies the
    // PGPASSWORD/`.pgpass` rules.
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
      ...(runtimeParams !== undefined ? { runtimeParams } : {}),
      ...(sslmode !== null && sslmode.length > 0 ? { sslmode } : {}),
      ...(sslrootcert !== null && sslrootcert.length > 0 ? { sslrootcert } : {}),
      ...clientCert,
      ...(connectTimeout !== undefined ? { connectTimeoutSeconds: connectTimeout } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Parse a libpq keyword/value DSN: whitespace-separated `keyword = value` pairs, with
 * single-quoted values and backslash escapes. Unknown keywords are ignored. Defaults follow
 * libpq: the user falls back to the OS account, the database to the user, and the port to 5432.
 */
function parseKeywordValueDsn(value: string, env: ParseEnv): PgConnInput | undefined {
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
    // Value: single-quoted (with `\` escapes) or bare (until whitespace). Only `\\`→`\` and
    // `\'`→`'` are unescaped; a backslash before any other char is preserved, so Windows cert
    // paths like `C:\certs\root.pem` and literal `\n` in a password survive intact. (A `\'`
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
        // The unquoted scan advances past any `\`, then errors when the escape has no
        // following char, so a lone trailing backslash is a parse error.
        if (!isEscapedChar(i) && value[i] === "\\" && i + 1 >= n) return undefined;
        if (isEscapedChar(i)) i++;
        val += value[i];
        i++;
      }
    }
    // An empty keyword is a parse error; a leading `=value` or whitespace-only key must fail,
    // not be silently dropped. (Reachable only after a `=` was consumed, so this is exactly the
    // empty-key case.)
    if (key.length === 0) return undefined;
    // `dbname` is remapped to `database` at parse time, so both aliases share one settings slot
    // and the last occurrence in the DSN wins.
    params.set(key === "dbname" ? "database" : key, val);
  }
  // Omitted fields fall back to libpq `PG*` env vars and then the libpq defaults. A libpq DSN
  // also accepts comma-separated multi-host failover (`host=h1,h2 port=5432,5433`), zipped by
  // `buildHostList`. Resolve a pgservice (`service=`/`PGSERVICE`); its settings sit above
  // env/defaults but below the explicit DSN keywords.
  const serviceSettings = resolveServiceSettings(
    params.get("service"),
    params.get("servicefile"),
    env,
  );
  if (serviceSettings === SERVICE_RESOLUTION_FAILED) return undefined;
  const svc = (key: string): string | undefined => serviceValue(serviceSettings, key);

  // No `hostaddr` support: it's stored only as a runtime param, so a `hostaddr`-only DSN dials
  // the default host, never the address. Don't use `hostaddr` as a host fallback — it would dial
  // a different endpoint than the reference driver.
  const hostString =
    params.get("host") ?? svc("host") ?? libpqEnv(env, "PGHOST") ?? defaultLibpqHost();
  // Explicit empty/non-numeric `port=` is a parse error; an absent `port` falls back to the
  // service, then `PGPORT`, then the libpq default.
  const portParam = params.get("port");
  let portString: string;
  if (portParam !== undefined) {
    portString = portParam;
  } else {
    const envPort = libpqPort(svc("port") ?? libpqEnv(env, "PGPORT"));
    if (envPort === undefined) return undefined;
    portString = String(envPort);
  }
  const hostList = buildHostList(hostString, portString);
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
  // libpq fills `sslmode` from the service, then `PGSSLMODE`, when the DSN omits it, before the
  // TLS-mode default.
  const sslmode = params.get("sslmode") ?? svc("sslmode") ?? libpqEnv(env, "PGSSLMODE");
  if (isInvalidSslmode(sslmode)) return undefined;
  const sslrootcert =
    params.get("sslrootcert") ?? svc("sslrootcert") ?? libpqEnv(env, "PGSSLROOTCERT");
  // libpq client cert (keyword, service, or PG*); both or neither.
  const clientCert = resolveClientCert((key) => params.get(key), svc, env);
  if (clientCert === "invalid") return undefined;
  const options = params.get("options") ?? svc("options");
  // Every other keyword setting (e.g. search_path, statement_timeout) is a startup runtime
  // param forwarded to the server / pg-delta.
  const runtimeParams = collectRuntimeParams(params, serviceSettings, env);
  // A `passfile=` setting (keyword or service) points `.pgpass` resolution at a non-default
  // file; non-empty wins over `PGPASSFILE`. A present `passfile=` (even empty) overrides
  // PGPASSFILE/default (see URL branch).
  const passfileParam = params.get("passfile");
  const passfile = passfileParam !== undefined ? passfileParam : svc("passfile");
  // libpq `connect_timeout` (keyword, service, or `PGCONNECT_TIMEOUT`). A present keyword (even
  // empty) overrides service/env and is parsed (empty → error); only an absent keyword falls
  // back.
  const connectTimeoutRaw = params.has("connect_timeout")
    ? params.get("connect_timeout")!
    : (svc("connect_timeout") ?? libpqEnv(env, "PGCONNECT_TIMEOUT"));
  const connectTimeout = libpqConnectTimeout(connectTimeoutRaw);
  if (connectTimeout === CONNECT_TIMEOUT_INVALID) return undefined;
  // Password precedence: a `password=` entry — even empty — overrides the service and
  // PGPASSWORD; an empty resolved value then falls through to `.pgpass`.
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
    ...(runtimeParams !== undefined ? { runtimeParams } : {}),
    ...(sslmode !== undefined && sslmode.length > 0 ? { sslmode } : {}),
    ...(sslrootcert !== undefined && sslrootcert.length > 0 ? { sslrootcert } : {}),
    ...clientCert,
    ...(connectTimeout !== undefined ? { connectTimeoutSeconds: connectTimeout } : {}),
  };
}

/**
 * libpq's default user when the connection string omits one: `PGUSER` (an env setting) takes
 * priority over the OS account, while an explicit `user=`/userinfo in the connection string
 * still wins over both (handled by the callers). The final `"postgres"` guard covers minimal
 * environments where neither is available.
 *
 * Empty `PG*` env vars are ignored, so an empty `PGUSER` falls through to the OS account — the
 * passwd entry for the effective uid, not the `$USER`/`$USERNAME` env vars (those are never
 * consulted; only `PGUSER` is an env override). Node's `os.userInfo().username` is the faithful
 * analogue; it can throw when there is no passwd entry, falling through to the `"postgres"`
 * guard.
 */
function osAccountUsername(): string | undefined {
  try {
    const name = userInfo().username;
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function defaultOsUser(env: ParseEnv): string {
  return libpqEnv(env, "PGUSER") ?? osAccountUsername() ?? "postgres";
}

/**
 * Mask the password in a connection string for safe inclusion in error output (CWE-209): a
 * malformed `--db-url` often still carries a secret. Pure string replacement (not
 * `URL.toString()`, which would percent-encode the literal `[REDACTED]`) covers URL userinfo
 * (`://user:secret@`), the malformed-but-credential-bearing URL case, and libpq keyword/value
 * DSNs (`password=…` / `password='…'`).
 *
 * The URL-userinfo password span is greedy (`.*`) so it consumes a literal `@` or `/` inside a
 * hand-typed password; the lookahead anchors the redaction boundary on the last `@` before the
 * authority terminator (`/`, `?`, `#`, or end), so `postgres://user:p@ss/word@host/db` redacts
 * the whole password rather than leaking a fragment. Where it cannot disambiguate it
 * over-redacts, which is the safe direction for CWE-209.
 *
 * The keyword-DSN `password=` branch matches a properly closed `'…'` value first (preserving any
 * trailing `key=value` pairs), then an unterminated opening quote through end-of-string (redact
 * to EOL rather than leaking past the first space), then a bare unquoted token.
 */
export function redactConnectionString(value: string): string {
  return value
    .replace(/(:\/\/[^:@/?#]*:).*(@)(?=[^@/?#]*(?:[/?#]|$))/, "$1[REDACTED]$2")
    .replace(/(\bpassword\s*=\s*)('(?:[^'\\]|\\.)*'|'.*$|\S+)/i, "$1[REDACTED]");
}
