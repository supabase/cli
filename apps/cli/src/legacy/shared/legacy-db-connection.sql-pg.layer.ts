import { readFileSync } from "node:fs";
import * as net from "node:net";
import type { ConnectionOptions } from "node:tls";
import { PgClient } from "@effect/sql-pg";
import { Duration, Effect, Layer, Redacted, type Scope } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { LegacyDbConnectError, LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import {
  type LegacyDbConnectOptions,
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "./legacy-db-connection.service.ts";
import { legacyResolveHostsOverHttps } from "./legacy-db-dns.ts";

// Go's role step-down (`apps/cli-go/internal/utils/connect.go:200-220`,
// `ConnectByConfigStream`): after connecting to a remote database as a
// platform-provisioned login role (`cli_login_*`) or a privileged role
// (`supabase_admin`), run `SET SESSION ROLE postgres` so subsequent statements
// (e.g. `CREATE EXTENSION`) execute as `postgres` rather than the temp role.
const SUPERUSER_ROLE = "supabase_admin";
const CLI_LOGIN_PREFIX = "cli_login_";
const SET_SESSION_ROLE = "SET SESSION ROLE postgres";

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
  if (cfg.options !== undefined && cfg.options.length > 0) {
    url.searchParams.set("options", cfg.options);
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
export function legacySslOptionFor(
  sslmode: string | undefined,
  isLocal: boolean,
  servername: string | undefined,
  caCert?: string,
): boolean | ConnectionOptions | undefined {
  if (isLocal) return undefined;
  if (sslmode === "disable" || sslmode === "allow") return false;
  const sni = servername !== undefined ? { servername } : {};
  // A configured `sslrootcert` pins the server CA (pgconn loads it into RootCAs);
  // it only affects the verifying modes.
  const ca = caCert !== undefined ? { ca: caCert } : {};
  if (sslmode === "verify-ca") {
    // pgconn's `verify-ca` verifies the CA chain but **skips hostname**
    // verification (`configTLS` sets a custom `VerifyPeerCertificate` with an
    // empty DNSName and does not set `ServerName` for the check); SNI still
    // carries the host. Node's equivalent is full chain verification with the
    // identity check disabled.
    return { rejectUnauthorized: true, checkServerIdentity: () => undefined, ...ca, ...sni };
  }
  if (sslmode === "verify-full") {
    // Full verification, including hostname against the servername.
    return { rejectUnauthorized: true, ...ca, ...sni };
  }
  // prefer / require / unset → TLS without verification (pgx default).
  return { rejectUnauthorized: false, ...sni };
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
): Array<boolean | ConnectionOptions | undefined> {
  if (isLocal) return [undefined];
  // pgconn skips TLS entirely for a unix-socket host (`NetworkAddress == "unix"`)
  // regardless of `sslmode`, so a socket DSN connects in plaintext; never send an
  // SSL negotiation over the socket. Independent of the local/remote flag because a
  // socket path is not the local services hostname (so `isLocal` is `false`).
  if (host !== undefined && legacyIsUnixSocketHost(host)) return [undefined];
  if (sslmode === "disable") return [false];
  if (sslmode === "allow") return [false, legacySslOptionFor("require", false, servername, caCert)];
  // pgconn: `require` + a root cert behaves like `verify-ca` (`configTLS`).
  const effectiveMode = sslmode === "require" && caCert !== undefined ? "verify-ca" : sslmode;
  if (
    effectiveMode === "require" ||
    effectiveMode === "verify-ca" ||
    effectiveMode === "verify-full"
  ) {
    return [legacySslOptionFor(effectiveMode, false, servername, caCert)];
  }
  // prefer (and the unset default): pgconn's raw list is `{tlsConfig, nil}`, but
  // `ConnectByUrl` strips the plaintext fallback because the primary is TLS, so
  // this is TLS-only — a failed TLS handshake must error, never downgrade.
  return [legacySslOptionFor(sslmode, false, servername, caCert)];
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
    const hasOptions = cfg.options !== undefined && cfg.options.length > 0;
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
        // Connect timeout parity: Go's `ToPostgresURL` always sets `connect_timeout`,
        // defaulting to 10s (`connect.go:24-28`); `ConnectLocalPostgres` uses 2s for
        // local (`connect.go:143-145`). A DSN/`PGCONNECT_TIMEOUT` value (>0) overrides
        // both. Without this a black-holed host would hang to the OS/driver default.
        connectTimeout: Duration.seconds(cfg.connectTimeoutSeconds ?? (isLocal ? 2 : 10)),
        maxConnections: 1,
      }).pipe(Effect.provide(Reactivity.layer));

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

    // Build the ordered attempt list, mirroring pgconn's fallback loop
    // (`configTLS` fallback configs, expanded across each resolved address by
    // `expandWithIPs`): each TLS config (`legacySslConfigsFor`) is tried against
    // each dial target (host × resolved IPs). `servername` is per target (the
    // original hostname when we dial a DoH-resolved IP).
    const attempts = dialTargets.flatMap(({ dialHost, port, servername }) =>
      legacySslConfigsFor(cfg.sslmode, isLocal, servername, caCert, dialHost).map((ssl) => ({
        client: makeClient(dialHost, port, ssl),
        // pgconn only short-circuits the fallback chain on an auth error when the
        // failed attempt used TLS (`pgconn.go:182`, gated on `fc.TLSConfig != nil`);
        // a TLS config is any non-plaintext `ssl` value.
        usedTls: ssl !== undefined && ssl !== false,
      })),
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
    // follow-up query.
    const lastIndex = attempts.length - 1;
    const lastProbed = attempts[lastIndex]!.client.pipe(
      Effect.tap((candidate) => candidate`select 1`),
    );
    const client = yield* attempts
      .slice(0, lastIndex)
      .reduceRight(
        (next, { client: attempt, usedTls }) =>
          attempt.pipe(
            Effect.tap((candidate) => candidate`select 1`),
            Effect.catch((error) =>
              legacyIsTerminalConnectError(error, usedTls) ? Effect.fail(error) : next,
            ),
          ),
        lastProbed,
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
    };
    return session;
  });

export const legacyDbConnectionSqlPgLayer = Layer.succeed(LegacyDbConnection, { connect });
