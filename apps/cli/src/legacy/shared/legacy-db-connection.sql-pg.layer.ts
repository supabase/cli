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
import { legacyResolveHostOverHttps } from "./legacy-db-dns.ts";

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
 */
function buildConnectionUrl(cfg: LegacyPgConnInput, host: string): string {
  const url = new URL(
    `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${host}:${cfg.port}/${encodeURIComponent(cfg.database)}`,
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
 * - **Local** (`ConnectLocalPostgres` sets `cc.TLSConfig = nil`) → no TLS.
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
  const rejectUnauthorized = sslmode === "verify-ca" || sslmode === "verify-full";
  return {
    rejectUnauthorized,
    ...(servername !== undefined ? { servername } : {}),
  };
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
    // `--dns-resolver https` is set (`connect.go:211-213`). We resolve the host
    // to an IP up front and dial that, but keep the original hostname for the
    // TLS `servername` (carried in the `ssl` option) so verification still
    // targets the hostname. Local connections always use the native resolver.
    const connectHost =
      dnsResolver === "https" && !isLocal ? yield* legacyResolveHostOverHttps(cfg.host) : cfg.host;
    const servername = connectHost === cfg.host ? undefined : cfg.host;
    const ssl = legacySslOptionFor(cfg.sslmode, isLocal, servername);
    const hasOptions = cfg.options !== undefined && cfg.options.length > 0;
    const client = yield* PgClient.make({
      // When a libpq `options` param is present, route everything through the
      // connection string so it reaches the server (see `buildConnectionUrl`);
      // otherwise pass discrete fields to avoid round-tripping the password.
      ...(hasOptions
        ? { url: Redacted.make(buildConnectionUrl(cfg, connectHost)) }
        : {
            host: connectHost,
            port: cfg.port,
            username: cfg.user,
            password: Redacted.make(cfg.password),
            database: cfg.database,
          }),
      // TLS parity with Go (`internal/utils/connect.go`): see `legacySslOptionFor`.
      ...(ssl === undefined ? {} : { ssl }),
      maxConnections: 1,
    }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.mapError(
        (error) => new LegacyDbConnectError({ message: `failed to connect to postgres: ${error}` }),
      ),
    );

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
