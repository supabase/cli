import { readFileSync } from "node:fs";
import * as net from "node:net";
import type { ConnectionOptions } from "node:tls";
import { PgClient } from "@effect/sql-pg";
import { Duration, Effect, Layer, Redacted, type Scope } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
// `pg` is also `@effect/sql-pg`'s transitive driver; we depend on it directly only
// for the COPY protocol (which `@effect/sql-pg` does not expose). Keep the direct
// `pg` version constraint in package.json aligned with the one `@effect/sql-pg`
// resolves, so the COPY path and the pooled path use the same driver.
import * as Pg from "pg";
import { to as pgCopyTo } from "pg-copy-streams";
import {
  LegacyDbConnectError,
  LegacyDbCopyError,
  LegacyDbExecError,
} from "./legacy-db-connection.errors.ts";
import {
  type LegacyDbConnectOptions,
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "./legacy-db-connection.service.ts";
import { legacyResolveHostsOverHttps } from "./legacy-db-dns.ts";

// node-postgres honors `queryMode: "extended"` to force the Parse/Bind/Execute
// protocol (`pg/lib/query.js` `requiresPreparation`), but `@types/pg` doesn't declare
// it. Augment `QueryConfig` so `queryRaw` can request it without an `as` cast.
declare module "pg" {
  interface QueryConfig {
    queryMode?: "extended" | "simple";
  }
}

// Go's role step-down (`apps/cli-go/internal/utils/connect.go:200-220`,
// `ConnectByConfigStream`): after connecting to a remote database as a
// platform-provisioned login role (`cli_login_*`) or a privileged role
// (`supabase_admin`), run `SET SESSION ROLE postgres` so subsequent statements
// (e.g. `CREATE EXTENSION`) execute as `postgres` rather than the temp role.
const SUPERUSER_ROLE = "supabase_admin";
const CLI_LOGIN_PREFIX = "cli_login_";
const SET_SESSION_ROLE = "SET SESSION ROLE postgres";

// Postgres date / timestamp / timestamptz type OIDs. node-postgres' default parsers
// decode these into a JS `Date`, which is millisecond-resolution and applies the
// local timezone — losing the microseconds that Go's pgx `time.Time` keeps (and
// risking a date shift for `date`). For `db query` we keep the raw Postgres text so
// the formatter can render Go's `time.Time` layout faithfully (microseconds intact).
const PG_DATE_OID = 1082;
const PG_TIMESTAMP_OID = 1114;
const PG_TIMESTAMPTZ_OID = 1184;
const legacyKeepRawText = (value: string): string => value;
/**
 * Per-query node-postgres type config: return the raw text for date/timestamp/
 * timestamptz, delegating every other OID to pg's default (text-mode) parser. Scoped
 * to `queryRaw` (only `db query` uses it), so other code paths keep native `Date`s.
 */
const legacyQueryRawTypes = {
  getTypeParser: (oid: number, format?: "text" | "binary") =>
    oid === PG_DATE_OID || oid === PG_TIMESTAMP_OID || oid === PG_TIMESTAMPTZ_OID
      ? legacyKeepRawText
      : format === undefined
        ? Pg.types.getTypeParser(oid)
        : Pg.types.getTypeParser(oid, format),
};

/**
 * Whether the connecting user requires the `SET SESSION ROLE postgres` step-down.
 * Go strips any Supavisor `.{ref}` tenant suffix first (`strings.Split(user, ".")[0]`)
 * before comparing. Go installs the step-down `AfterConnect` hook **only on the
 * remote path** (`ConnectByConfigStream`, `connect.go:211-222`); the local path
 * (`ConnectLocalPostgres`) never installs it, regardless of the configured user — so
 * the caller must also gate on `!isLocal` (a local `--db-url` can set any user).
 */
function needsRoleStepDown(user: string): boolean {
  const base = user.split(".")[0] ?? user;
  return base.toLowerCase() === SUPERUSER_ROLE || base.startsWith(CLI_LOGIN_PREFIX);
}

// pgconn terminates the multi-host fallback chain (rather than trying the next
// host) when the server returns an authentication/authorization/catalog/privilege
// error, surfacing it instead of masking it behind a later host (jackc/pgconn
// `pgconn.go:159-192`, documented at `:127-130`). These are the SQLSTATEs pgconn
// breaks on; `28000` is gated on the failed attempt having used TLS (`pgconn.go:182`,
// `fc.TLSConfig != nil`).
const LEGACY_TERMINAL_SQLSTATES = new Set(["28P01", "3D000", "42501"]);
const LEGACY_TLS_GATED_SQLSTATE = "28000";

/**
 * Whether a failed connection attempt should terminate the multi-host fallback
 * chain instead of falling through to the next host. Mirrors pgconn's
 * `ConnectConfig`, which retries fallbacks only for connection-establishment
 * errors and returns server-side auth errors immediately. The `pg` driver attaches
 * the Postgres SQLSTATE as a `code` property on the server error (carried through
 * `@effect/sql`'s `SqlError.cause`), so we walk the `cause` chain looking for one.
 */
export function legacyIsTerminalConnectError(error: unknown, usedTls: boolean): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const code = Reflect.get(current, "code");
    if (typeof code === "string") {
      if (LEGACY_TERMINAL_SQLSTATES.has(code)) return true;
      if (code === LEGACY_TLS_GATED_SQLSTATE && usedTls) return true;
    }
    current = Reflect.get(current, "cause");
  }
  return false;
}

/**
 * Whether a dial host is a libpq unix-socket path. pgconn skips TLS/DNS entirely for
 * a unix `NetworkAddress` regardless of `sslmode` (jackc/pgconn `configTLS`), so a
 * socket DSN connects in plaintext — mirrored here. Matches pgconn v1.14.3
 * `isAbsolutePath` (`config.go:112-129`): a forward-slash prefix (POSIX) OR a Windows
 * absolute path — an **uppercase** drive letter `A`-`Z`, then `:`, then `\`
 * (lowercase `c:\…` is NOT a socket in pgconn, so it stays TCP here too).
 */
export function legacyIsUnixSocketHost(host: string): boolean {
  if (host.startsWith("/")) return true;
  return (
    host.length >= 3 && host[0]! >= "A" && host[0]! <= "Z" && host[1] === ":" && host[2] === "\\"
  );
}

/**
 * Build a `postgresql://` connection string carrying the libpq `options` startup
 * parameter. `PgClient.make` only forwards a fixed set of discrete fields to the
 * underlying `pg` pool and has no `options` field, so the legacy Supavisor pooler
 * format (`?options=reference=<ref>`) must travel via the connection string, which
 * `pg-connection-string` parses back into the startup `options` param. `host` is
 * passed explicitly so a DoH-resolved IP can be substituted while TLS still
 * verifies the original hostname (via the `ssl.servername` carried separately).
 * The URL carries no `sslmode`, so the explicit `ssl` config wins.
 *
 * An IPv6 literal host is wrapped in brackets so `new URL()` accepts it, matching
 * Go's `ToPostgresURL` (which formats the host via `net.JoinHostPort`). This
 * covers a direct IPv6 `--db-url` carrying `?options=…` and the DoH path when a
 * Supavisor URL resolves to an AAAA address.
 *
 * A unix-socket host (an absolute path) is percent-encoded as the authority and
 * its port is dropped: `pg-connection-string` only accepts a socket host in a URL
 * via its `/^%2f/i` branch (`postgresql://%2Fvar%2Frun%2Fpostgresql/db`), and a
 * socket dial has no TCP port. Interpolating the raw path makes `new URL()` throw,
 * which would otherwise break a socket DSN carrying startup `options`.
 */
/**
 * Merge the libpq `options` startup param with the parsed `runtimeParams`, encoding
 * each runtime param as a `-c <key>=<value>` flag. Go sends every
 * `pgconn.Config.RuntimeParams` entry as a discrete StartupMessage parameter
 * (`ToPostgresURL`, `apps/cli-go/internal/utils/connect.go:31-33`), so the live
 * query/COPY connection applies `search_path`, `statement_timeout`, etc.
 * node-postgres has no discrete startup-param API, but Postgres applies the
 * `-c key=value` flags carried in the `options` startup param to the same session
 * GUCs — behaviorally equivalent, the same pragmatic mapping already used for
 * `options`. Any existing `cfg.options` (e.g. the Supavisor `reference=<ref>` form)
 * is preserved, with the `-c` flags appended. Returns `undefined` when neither is set.
 */
export function legacyMergedConnectionOptions(cfg: LegacyPgConnInput): string | undefined {
  const base = cfg.options !== undefined && cfg.options.length > 0 ? cfg.options : undefined;
  const params = cfg.runtimeParams;
  if (params === undefined || Object.keys(params).length === 0) return base;
  // libpq `options` is space-delimited; a literal backslash or space in a value
  // must be backslash-escaped.
  const escape = (value: string): string => value.replace(/([\\ ])/g, "\\$1");
  const flags = Object.entries(params).map(([key, value]) => `-c ${key}=${escape(value)}`);
  return [...(base === undefined ? [] : [base]), ...flags].join(" ");
}

export function legacyBuildConnectionUrl(
  cfg: LegacyPgConnInput,
  host: string,
  port: number = cfg.port,
): string {
  const isSocket = legacyIsUnixSocketHost(host);
  const hostPart = isSocket ? encodeURIComponent(host) : net.isIP(host) === 6 ? `[${host}]` : host;
  const portPart = isSocket ? "" : `:${port}`;
  const url = new URL(
    `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${hostPart}${portPart}/${encodeURIComponent(cfg.database)}`,
  );
  const options = legacyMergedConnectionOptions(cfg);
  if (options !== undefined && options.length > 0) {
    url.searchParams.set("options", options);
  }
  return url.toString();
}

/**
 * Map Go's TLS behavior to the `pg` driver's `ssl` option. Parity with
 * `apps/cli-go/internal/utils/connect.go`:
 *
 * - **Local** (`ConnectLocalPostgres` sets `cc.TLSConfig = nil`) → no TLS;
 *   return `undefined` so `pg` stays in plaintext mode. `sslmode` is ignored,
 *   matching Go, which overwrites the local config unconditionally.
 * - **Remote** maps the URL's `sslmode` to the *primary* config pgconn would try
 *   (`config.go:772-780`'s fallback list), since the `pg` driver carries a single
 *   `ssl` option and cannot replay pgconn's TLS↔plaintext fallback:
 *   - `disable` and `allow` → plaintext (`ssl: false`). pgconn's `allow` list is
 *     `{nil, tlsConfig}`, i.e. a **non-TLS primary** with a TLS fallback, so an
 *     `allow` DSN to a plaintext endpoint must connect without TLS.
 *   - `verify-ca` / `verify-full` → TLS **with** certificate verification;
 *   - `prefer` (and pgconn's default) / `require` / unset → TLS **without**
 *     verification (their primary is the TLS config).
 *
 * `servername` (the original hostname) is carried for **every** TLS mode, not
 * just the verifying ones. Go enables `sslsni` by default (`pgconn`'s
 * `config.go:768` sets `tlsConfig.ServerName = host` for all TLS sslmodes when
 * the host is not a literal IP) and keeps the original hostname in the
 * connection config even when `--dns-resolver https` swaps the dial target for a
 * DoH-resolved IP (via `FallbackLookupIP`). Dropping the SNI on `require`/
 * `prefer` would break endpoints/proxies that route TLS on the server name.
 */
export interface LegacyClientCert {
  readonly cert: string;
  readonly key: string;
  readonly passphrase?: string;
}

export function legacySslOptionFor(
  sslmode: string | undefined,
  isLocal: boolean,
  servername: string | undefined,
  caCert?: string,
  clientCert?: LegacyClientCert,
): boolean | ConnectionOptions | undefined {
  if (isLocal) return undefined;
  if (sslmode === "disable" || sslmode === "allow") return false;
  const sni = servername !== undefined ? { servername } : {};
  // A configured `sslrootcert` pins the server CA (pgconn loads it into RootCAs);
  // it only affects the verifying modes.
  const ca = caCert !== undefined ? { ca: caCert } : {};
  // pgconn attaches the client `sslcert`/`sslkey` (and optional `sslpassword`) to the
  // single shared `tlsConfig.Certificates` regardless of verification mode
  // (`config.go:710-762`), so carry it on every TLS config.
  const clientCertOpts: ConnectionOptions =
    clientCert !== undefined
      ? {
          cert: clientCert.cert,
          key: clientCert.key,
          ...(clientCert.passphrase !== undefined ? { passphrase: clientCert.passphrase } : {}),
        }
      : {};
  if (sslmode === "verify-ca") {
    // pgconn's `verify-ca` verifies the CA chain but **skips hostname**
    // verification (`configTLS` sets a custom `VerifyPeerCertificate` with an
    // empty DNSName and does not set `ServerName` for the check); SNI still
    // carries the host. Node's equivalent is full chain verification with the
    // identity check disabled.
    return {
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
      ...ca,
      ...clientCertOpts,
      ...sni,
    };
  }
  if (sslmode === "verify-full") {
    // Full verification, including hostname against the servername.
    return { rejectUnauthorized: true, ...ca, ...clientCertOpts, ...sni };
  }
  // prefer / require / unset → TLS without verification (pgx default).
  return { rejectUnauthorized: false, ...clientCertOpts, ...sni };
}

/**
 * The ordered list of `ssl` configs to try for a connection. pgconn's raw
 * `configTLS` fallback list (`config.go:772-780`) is **post-processed** by Go's
 * `ConnectByUrl` (`apps/cli-go/internal/utils/connect.go:156-168`), which strips
 * every non-TLS fallback whenever the primary config uses TLS ("No fallback from
 * TLS to unsecure connection"). The `pg` driver carries a single `ssl` option and
 * cannot replay pgconn's internal fallback, so `connect` retries across the
 * *post-stripping* list:
 *
 * - `disable` → `[plaintext]` (primary is plaintext; nothing stripped)
 * - `allow` → `[plaintext, TLS]` (`{nil, tlsConfig}` — non-TLS primary, so the
 *   TLS fallback survives the strip)
 * - `prefer` / unset (pgconn's default) → `[TLS]`. pgconn's raw list is
 *   `{tlsConfig, nil}`, but the primary is TLS, so `ConnectByUrl` drops the
 *   plaintext fallback. Go therefore **fails** rather than downgrading a default
 *   remote connection to plaintext, and so must this port.
 * - `require` / `verify-ca` / `verify-full` → `[TLS]` (TLS only)
 *
 * `servername` (the original hostname) is per dial host — set when a DoH-resolved
 * IP was substituted so TLS/SNI still targets the hostname. `caCert` is the
 * loaded `sslrootcert` bundle; pgconn treats `require` + a root cert as
 * `verify-ca`, so it is promoted here.
 */
export function legacySslConfigsFor(
  sslmode: string | undefined,
  isLocal: boolean,
  servername: string | undefined,
  caCert?: string,
  host?: string,
  clientCert?: LegacyClientCert,
): Array<boolean | ConnectionOptions | undefined> {
  if (isLocal) return [undefined];
  // pgconn skips TLS entirely for a unix-socket host (`NetworkAddress == "unix"`)
  // regardless of `sslmode`, so a socket DSN connects in plaintext; never send an
  // SSL negotiation over the socket. Independent of the local/remote flag because a
  // socket path is not the local services hostname (so `isLocal` is `false`).
  if (host !== undefined && legacyIsUnixSocketHost(host)) return [undefined];
  if (sslmode === "disable") return [false];
  if (sslmode === "allow")
    return [false, legacySslOptionFor("require", false, servername, caCert, clientCert)];
  // pgconn: `require` + a root cert behaves like `verify-ca` (`configTLS`).
  const effectiveMode = sslmode === "require" && caCert !== undefined ? "verify-ca" : sslmode;
  if (
    effectiveMode === "require" ||
    effectiveMode === "verify-ca" ||
    effectiveMode === "verify-full"
  ) {
    return [legacySslOptionFor(effectiveMode, false, servername, caCert, clientCert)];
  }
  // prefer (and the unset default): pgconn's raw list is `{tlsConfig, nil}`, but
  // `ConnectByUrl` strips the plaintext fallback because the primary is TLS, so
  // this is TLS-only — a failed TLS handshake must error, never downgrade.
  return [legacySslOptionFor(sslmode, false, servername, caCert, clientCert)];
}

/**
 * Default `LegacyDbConnection` layer, backed by `@effect/sql-pg` (pure-JS `pg`
 * driver, no native addon — bundles under `bun build --compile`). Each
 * `connect` builds a scoped single-client connection that closes on scope exit.
 */
const connect = (
  cfg: LegacyPgConnInput,
  { isLocal, dnsResolver }: LegacyDbConnectOptions,
): Effect.Effect<LegacyDbSession, LegacyDbConnectError, Scope.Scope> =>
  Effect.gen(function* () {
    // pgconn dials the primary host then each HA fallback in order
    // (`config.go:326-362`); `cfg.fallbacks` carries the extras parsed from a
    // libpq multi-host connection string. Go installs the Cloudflare DoH resolver
    // for remote connections when `--dns-resolver https` is set
    // (`connect.go:211-213`): it resolves each host to **all** its IPs
    // (`FallbackLookupIP`) and dials them in order, so we resolve every config host
    // up front and retry each. We dial a resolved IP but keep the original hostname
    // for the TLS `servername` (carried in the `ssl` option) so verification still
    // targets the hostname. Local connections use the host verbatim (native resolver).
    const hostList = [{ host: cfg.host, port: cfg.port }, ...(cfg.fallbacks ?? [])];
    const dialTargets: Array<{ dialHost: string; port: number; servername: string | undefined }> =
      [];
    for (const { host, port } of hostList) {
      // pgconn never resolves a unix-socket host over DNS, so skip DoH for socket
      // paths (DoH-resolving `/var/run/postgresql` is meaningless).
      const resolved =
        dnsResolver === "https" && !isLocal && !legacyIsUnixSocketHost(host)
          ? yield* legacyResolveHostsOverHttps(host)
          : [host];
      for (const dialHost of resolved) {
        dialTargets.push({ dialHost, port, servername: dialHost === host ? undefined : host });
      }
    }
    // Route through the connection string whenever a libpq `options` param OR
    // parsed `runtimeParams` are present, so both reach the live connection.
    const hasOptions = legacyMergedConnectionOptions(cfg) !== undefined;
    // Connect timeout parity: Go's `ToPostgresURL` always sets `connect_timeout`,
    // defaulting to 10s (`connect.go:24-28`); `ConnectLocalPostgres` uses 2s for
    // local (`connect.go:143-145`). A DSN/`PGCONNECT_TIMEOUT` value (>0) overrides
    // both. Without this a black-holed host would hang to the OS/driver default.
    const connectTimeoutSeconds = cfg.connectTimeoutSeconds ?? (isLocal ? 2 : 10);
    const makeClient = (
      dialHost: string,
      port: number,
      sslOption: boolean | ConnectionOptions | undefined,
    ) =>
      PgClient.make({
        // When a libpq `options` param is present, route everything through the
        // connection string so it reaches the server (see `buildConnectionUrl`);
        // otherwise pass discrete fields to avoid round-tripping the password.
        ...(hasOptions
          ? { url: Redacted.make(legacyBuildConnectionUrl(cfg, dialHost, port)) }
          : {
              host: dialHost,
              port,
              username: cfg.user,
              password: Redacted.make(cfg.password),
              database: cfg.database,
            }),
        // TLS parity with Go (`internal/utils/connect.go`): see `legacySslOptionFor`.
        ...(sslOption === undefined ? {} : { ssl: sslOption }),
        connectTimeout: Duration.seconds(connectTimeoutSeconds),
        maxConnections: 1,
      }).pipe(Effect.provide(Reactivity.layer));

    // The raw `pg.ClientConfig` for the same dial target, mirroring `makeClient`'s
    // discrete-vs-url choice. `copyToCsv` uses it to open a dedicated node-postgres
    // connection for the COPY protocol (which `@effect/sql-pg` does not expose),
    // against whichever target the primary connection won.
    const buildRawPgConfig = (
      dialHost: string,
      port: number,
      sslOption: boolean | ConnectionOptions | undefined,
    ): Pg.ClientConfig => ({
      ...(hasOptions
        ? { connectionString: legacyBuildConnectionUrl(cfg, dialHost, port) }
        : { host: dialHost, port, user: cfg.user, password: cfg.password, database: cfg.database }),
      ...(sslOption === undefined ? {} : { ssl: sslOption }),
      connectionTimeoutMillis: connectTimeoutSeconds * 1000,
    });

    const toConnectError = (error: unknown) =>
      new LegacyDbConnectError({ message: `failed to connect to postgres: ${error}` });

    // Load the `sslrootcert` CA bundle (pgconn reads it into `RootCAs` at parse
    // time; a missing/unreadable file aborts). Skipped for local connections, which
    // never use TLS. pgconn builds TLS per fallback host, so the CA must be loaded
    // whenever ANY dial target is non-socket — a socket primary with a TCP fallback
    // still needs it (`legacySslConfigsFor` already plaintexts socket targets, so
    // the CA is never applied to a socket dial).
    const rootcertPath = cfg.sslrootcert;
    const anyTcpTarget = dialTargets.some(({ dialHost }) => !legacyIsUnixSocketHost(dialHost));
    const caCert =
      rootcertPath !== undefined && rootcertPath.length > 0 && !isLocal && anyTcpTarget
        ? yield* Effect.try({
            try: () => readFileSync(rootcertPath, "utf8"),
            catch: (error) =>
              new LegacyDbConnectError({
                message: `failed to read sslrootcert ${rootcertPath}: ${error}`,
              }),
          })
        : undefined;

    // Load the client `sslcert`/`sslkey` (pgconn's `configTLS` reads both into
    // `tlsConfig.Certificates` for cert auth; the parser only sets them as a pair).
    // Same non-local/TCP gate as the CA bundle. `sslpassword` decrypts an encrypted
    // key (Node's `tls` `passphrase`). Bound to locals so the narrowing holds in the
    // `Effect.try` closures.
    const certPath = cfg.sslcert;
    const keyPath = cfg.sslkey;
    const clientCert =
      certPath !== undefined && keyPath !== undefined && !isLocal && anyTcpTarget
        ? {
            cert: yield* Effect.try({
              try: () => readFileSync(certPath, "utf8"),
              catch: (error) =>
                new LegacyDbConnectError({
                  message: `failed to read sslcert ${certPath}: ${error}`,
                }),
            }),
            key: yield* Effect.try({
              try: () => readFileSync(keyPath, "utf8"),
              catch: (error) =>
                new LegacyDbConnectError({
                  message: `failed to read sslkey ${keyPath}: ${error}`,
                }),
            }),
            ...(cfg.sslpassword !== undefined ? { passphrase: cfg.sslpassword } : {}),
          }
        : undefined;

    // Build the ordered attempt list, mirroring pgconn's fallback loop
    // (`configTLS` fallback configs, expanded across each resolved address by
    // `expandWithIPs`): each TLS config (`legacySslConfigsFor`) is tried against
    // each dial target (host × resolved IPs). `servername` is per target (the
    // original hostname when we dial a DoH-resolved IP).
    const attempts = dialTargets.flatMap(({ dialHost, port, servername }) =>
      legacySslConfigsFor(cfg.sslmode, isLocal, servername, caCert, dialHost, clientCert).map(
        (ssl) => ({
          client: makeClient(dialHost, port, ssl),
          // pgconn only short-circuits the fallback chain on an auth error when the
          // failed attempt used TLS (`pgconn.go:182`, gated on `fc.TLSConfig != nil`);
          // a TLS config is any non-plaintext `ssl` value.
          usedTls: ssl !== undefined && ssl !== false,
          rawConfig: buildRawPgConfig(dialHost, port, ssl),
        }),
      ),
    );

    // The `pg` driver connects lazily and cannot replay pgconn's fallback, so probe
    // every attempt with `select 1` to force the connection, falling through to the
    // next on failure. pgconn retries fallbacks only for connection-establishment
    // errors; a server-side auth/authorization/catalog/privilege error terminates the
    // chain (`pgconn.go:159-192`), so a terminal SQLSTATE re-raises instead of masking
    // the primary's failure behind a later host. The final attempt is probed too (not
    // left lazy): Go always dials eagerly — the main path via `pgx.ConnectConfig` and
    // the temp-role wait via `pgconn.ConnectConfig` (`db_url.go:192`) — so `connect`
    // must return a live session for callers like `waitForTempRole` that don't run a
    // follow-up query. The winning attempt's `rawConfig` is carried out so `copyToCsv`
    // can reuse the exact dial target the primary connection succeeded against.
    const probe = (attempt: (typeof attempts)[number]) =>
      attempt.client.pipe(
        Effect.tap((candidate) => candidate`select 1`),
        Effect.map((candidate) => ({ candidate, rawConfig: attempt.rawConfig })),
      );
    const lastIndex = attempts.length - 1;
    const { candidate: client, rawConfig: winningRawConfig } = yield* attempts
      .slice(0, lastIndex)
      .reduceRight(
        (next, attempt) =>
          probe(attempt).pipe(
            Effect.catch((error) =>
              legacyIsTerminalConnectError(error, attempt.usedTls) ? Effect.fail(error) : next,
            ),
          ),
        probe(attempts[lastIndex]!),
      )
      .pipe(Effect.mapError(toConnectError));

    // Step down from the temp/privileged login role before any further SQL — but
    // only for remote connections: Go installs this hook in `ConnectByConfigStream`,
    // not `ConnectLocalPostgres`, so a local `--db-url` using `supabase_admin`/
    // `cli_login_*` must not run it. `maxConnections: 1` guarantees the single
    // physical connection is reused, so the session-scoped role persists for `exec`.
    if (!isLocal && needsRoleStepDown(cfg.user)) {
      yield* client.unsafe(SET_SESSION_ROLE).pipe(
        Effect.asVoid,
        Effect.mapError(
          (error) => new LegacyDbConnectError({ message: `failed to set session role: ${error}` }),
        ),
      );
    }

    // `inspect report` runs ~14 `COPY (...) TO STDOUT` statements. node-postgres'
    // COPY protocol needs the raw client (which `@effect/sql-pg` does not surface),
    // so the session opens ONE dedicated raw connection against the winning dial
    // target and reuses it for every copy — matching Go, which runs all copies on a
    // single `pgconn` (`report.go:35-59`). It is created lazily on first copy (so
    // `test db` / `inspect db`, which never copy, never open it) and closed by a
    // scope finalizer when the session's scope closes. The step-down runs once, here,
    // so every COPY executes with the same privileges as the primary session.
    let rawClient: Pg.Client | undefined;
    yield* Effect.addFinalizer(() =>
      rawClient === undefined
        ? Effect.void
        : Effect.promise(() => rawClient!.end().catch(() => {})),
    );
    // A dedicated raw node-postgres client, reused by `copyToCsv` (COPY protocol)
    // and `queryRaw` (full result metadata) — neither is surfaced by
    // `@effect/sql-pg`. Opened lazily against the winning dial target so TLS /
    // fallback / DoH parity is preserved, with the same role step-down as the
    // primary session. Establishing this connection (and its step-down) is a
    // connection-setup concern, so it fails with `LegacyDbConnectError` using the
    // same message shape as the primary `connect` — not a copy/exec error. Only
    // the COPY stream itself (in `copyToCsv`) raises `LegacyDbCopyError`; this
    // keeps `queryRaw` failures from surfacing a misleading "failed to copy
    // output" message when the shared client cannot be established.
    const acquireRawClient = Effect.gen(function* () {
      if (rawClient !== undefined) return rawClient;
      const fresh = new Pg.Client(winningRawConfig);
      yield* Effect.tryPromise({
        try: () => fresh.connect(),
        catch: (error) =>
          new LegacyDbConnectError({ message: `failed to connect to postgres: ${error}` }),
      });
      if (!isLocal && needsRoleStepDown(cfg.user)) {
        yield* Effect.tryPromise({
          try: () => fresh.query(SET_SESSION_ROLE),
          catch: (error) =>
            new LegacyDbConnectError({ message: `failed to set session role: ${error}` }),
        });
      }
      rawClient = fresh;
      return fresh;
    });

    const session: LegacyDbSession = {
      exec: (sql) =>
        client.unsafe(sql).pipe(
          Effect.asVoid,
          Effect.mapError((error) => new LegacyDbExecError({ message: String(error) })),
        ),
      query: (sql, params) =>
        client
          .unsafe<Record<string, unknown>>(sql, params)
          .pipe(Effect.mapError((error) => new LegacyDbExecError({ message: String(error) }))),
      extensionExists: (name) =>
        client`select 1 from pg_extension where extname = ${name}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError((error) => new LegacyDbExecError({ message: String(error) })),
        ),
      queryRaw: (sql) =>
        Effect.gen(function* () {
          // `acquireRawClient` fails with `LegacyDbConnectError`; surface it
          // verbatim (the public `queryRaw` type allows it) rather than masking a
          // connection failure as "failed to execute query".
          const activeClient = yield* acquireRawClient;
          // Capture the raw command tag from the protocol message: node-postgres'
          // parsed `Result.command` keeps only the first tag word (e.g. "CREATE"
          // for "CREATE TABLE"), but Go prints the full `pgconn` tag.
          let commandTag = "";
          const onComplete = (msg: { readonly text?: string }) => {
            if (typeof msg.text === "string") commandTag = msg.text;
          };
          activeClient.connection.on("commandComplete", onComplete);
          const result = yield* Effect.tryPromise({
            // `rowMode: "array"` returns rows positionally so duplicate column
            // names survive (Go reads pgx values by index). `types` keeps date/
            // timestamp/timestamptz cells as raw text to preserve microseconds.
            // `queryMode: "extended"` forces the Parse/Bind/Execute protocol so a
            // multi-statement string is rejected — Go's pgx v4 defaults to the
            // extended protocol (`cannot insert multiple commands into a prepared
            // statement`), whereas node-postgres' default simple protocol would
            // execute every statement (an empty `values` array stays simple, since
            // pg gates preparation on `values.length > 0`).
            try: () =>
              activeClient.query<Array<unknown>>({
                text: sql,
                queryMode: "extended",
                rowMode: "array",
                types: legacyQueryRawTypes,
              }),
            catch: (error) =>
              new LegacyDbExecError({ message: `failed to execute query: ${error}` }),
          }).pipe(
            Effect.ensuring(
              Effect.sync(() =>
                activeClient.connection.removeListener("commandComplete", onComplete),
              ),
            ),
          );
          return {
            fields: result.fields.map((field) => field.name),
            // Surface the column type OIDs so the table/CSV formatter can render
            // float4/float8 with Go's %g while integer columns stay plain.
            fieldTypeIds: result.fields.map((field) => field.dataTypeID),
            rows: result.rows,
            commandTag,
          };
        }),
      copyToCsv: (sql) =>
        Effect.gen(function* () {
          const activeClient = yield* acquireRawClient;
          return yield* Effect.callback<Uint8Array, LegacyDbCopyError>((resume) => {
            const stream = activeClient.query(pgCopyTo(sql));
            const chunks: Array<Buffer> = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("error", (error: Error) =>
              resume(
                Effect.fail(new LegacyDbCopyError({ message: `failed to copy output: ${error}` })),
              ),
            );
            stream.on("end", () => resume(Effect.succeed(new Uint8Array(Buffer.concat(chunks)))));
          });
        }),
    };
    return session;
  });

export const legacyDbConnectionSqlPgLayer = Layer.succeed(LegacyDbConnection, { connect });
