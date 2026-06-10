import * as net from "node:net";
import type { ConnectionOptions } from "node:tls";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted, type Scope } from "effect";
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
 * before comparing. Go additionally gates this on the connection being remote, but a
 * local connection always uses the plain `postgres` user, so a username-only check is
 * observably identical for the local/db-url/linked paths the resolver produces.
 */
function needsRoleStepDown(user: string): boolean {
  const base = user.split(".")[0] ?? user;
  return base.toLowerCase() === SUPERUSER_ROLE || base.startsWith(CLI_LOGIN_PREFIX);
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
 */
export function legacyBuildConnectionUrl(cfg: LegacyPgConnInput, host: string): string {
  const hostPart = net.isIP(host) === 6 ? `[${host}]` : host;
  const url = new URL(
    `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${hostPart}:${cfg.port}/${encodeURIComponent(cfg.database)}`,
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
): boolean | ConnectionOptions | undefined {
  if (isLocal) return undefined;
  if (sslmode === "disable" || sslmode === "allow") return false;
  const sni = servername !== undefined ? { servername } : {};
  if (sslmode === "verify-ca") {
    // pgconn's `verify-ca` verifies the CA chain but **skips hostname**
    // verification (`configTLS` sets a custom `VerifyPeerCertificate` with an
    // empty DNSName and does not set `ServerName` for the check); SNI still
    // carries the host. Node's equivalent is full chain verification with the
    // identity check disabled.
    return { rejectUnauthorized: true, checkServerIdentity: () => undefined, ...sni };
  }
  if (sslmode === "verify-full") {
    // Full verification, including hostname against the servername.
    return { rejectUnauthorized: true, ...sni };
  }
  // prefer / require / unset → TLS without verification (pgx default).
  return { rejectUnauthorized: false, ...sni };
}

/**
 * The ordered list of `ssl` configs to try for a connection, mirroring pgconn's
 * fallback list (`configTLS`, `config.go:772-780`). The `pg` driver carries a
 * single `ssl` option and cannot replay pgconn's internal TLS↔plaintext
 * fallback, so `connect` retries across this list:
 *
 * - `disable` → `[plaintext]`
 * - `allow` → `[plaintext, TLS]` (`{nil, tlsConfig}` — non-TLS primary)
 * - `prefer` / unset (pgconn's default) → `[TLS, plaintext]` (`{tlsConfig, nil}`)
 * - `require` / `verify-ca` / `verify-full` → `[TLS]` (TLS only)
 *
 * `servername` (the original hostname) is per dial host — set when a DoH-resolved
 * IP was substituted so TLS/SNI still targets the hostname.
 */
export function legacySslConfigsFor(
  sslmode: string | undefined,
  isLocal: boolean,
  servername: string | undefined,
): Array<boolean | ConnectionOptions | undefined> {
  if (isLocal) return [undefined];
  if (sslmode === "disable") return [false];
  if (sslmode === "allow") return [false, legacySslOptionFor("require", false, servername)];
  if (sslmode === "require" || sslmode === "verify-ca" || sslmode === "verify-full") {
    return [legacySslOptionFor(sslmode, false, servername)];
  }
  // prefer (and the unset default) try TLS first, then fall back to plaintext.
  return [legacySslOptionFor(sslmode, false, servername), false];
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
    // Go installs the Cloudflare DoH resolver for remote connections when
    // `--dns-resolver https` is set (`connect.go:211-213`). It resolves the host
    // to **all** its IPs (`FallbackLookupIP`) and pgconn dials them in order, so
    // we resolve the full list and retry each. We dial a resolved IP but keep the
    // original hostname for the TLS `servername` (carried in the `ssl` option) so
    // verification still targets the hostname. Local connections use the host
    // verbatim (native resolver).
    const dialHosts =
      dnsResolver === "https" && !isLocal
        ? yield* legacyResolveHostsOverHttps(cfg.host)
        : [cfg.host];
    const hasOptions = cfg.options !== undefined && cfg.options.length > 0;
    const makeClient = (dialHost: string, sslOption: boolean | ConnectionOptions | undefined) =>
      PgClient.make({
        // When a libpq `options` param is present, route everything through the
        // connection string so it reaches the server (see `buildConnectionUrl`);
        // otherwise pass discrete fields to avoid round-tripping the password.
        ...(hasOptions
          ? { url: Redacted.make(legacyBuildConnectionUrl(cfg, dialHost)) }
          : {
              host: dialHost,
              port: cfg.port,
              username: cfg.user,
              password: Redacted.make(cfg.password),
              database: cfg.database,
            }),
        // TLS parity with Go (`internal/utils/connect.go`): see `legacySslOptionFor`.
        ...(sslOption === undefined ? {} : { ssl: sslOption }),
        maxConnections: 1,
      }).pipe(Effect.provide(Reactivity.layer));

    const toConnectError = (error: unknown) =>
      new LegacyDbConnectError({ message: `failed to connect to postgres: ${error}` });

    // Build the ordered attempt list, mirroring pgconn's fallback loop
    // (`configTLS` fallback configs, expanded across each resolved address by
    // `expandWithIPs`): each TLS config (`legacySslConfigsFor`) is tried against
    // each dial host. `servername` is per host (the original hostname when we
    // dial a DoH-resolved IP).
    const attempts = dialHosts.flatMap((dialHost) => {
      const servername = dialHost === cfg.host ? undefined : cfg.host;
      return legacySslConfigsFor(cfg.sslmode, isLocal, servername).map((ssl) =>
        makeClient(dialHost, ssl),
      );
    });

    // The `pg` driver connects lazily and cannot replay pgconn's fallback, so
    // probe each non-final attempt with `select 1` to force the connection and
    // fall through to the next on failure. `reduceRight` with no seed makes the
    // final attempt the base case — it is left lazy (no extra round-trip), so the
    // common single-attempt path is byte-identical to a plain connect.
    const client = yield* attempts
      .reduceRight((next, attempt) =>
        attempt.pipe(
          Effect.tap((candidate) => candidate`select 1`),
          Effect.catch(() => next),
        ),
      )
      .pipe(Effect.mapError(toConnectError));

    // Step down from the temp/privileged login role before any further SQL.
    // `maxConnections: 1` guarantees the single physical connection is reused, so
    // the session-scoped role persists for every subsequent `exec`.
    if (needsRoleStepDown(cfg.user)) {
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
      extensionExists: (name) =>
        client`select 1 from pg_extension where extname = ${name}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError((error) => new LegacyDbExecError({ message: String(error) })),
        ),
    };
    return session;
  });

export const legacyDbConnectionSqlPgLayer = Layer.succeed(LegacyDbConnection, { connect });
