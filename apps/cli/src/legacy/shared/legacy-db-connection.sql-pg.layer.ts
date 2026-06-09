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
 * `pg-connection-string` parses back into the startup `options` param.
 */
function buildConnectionUrl(cfg: LegacyPgConnInput): string {
  const url = new URL(
    `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}/${encodeURIComponent(cfg.database)}`,
  );
  if (cfg.options !== undefined && cfg.options.length > 0) {
    url.searchParams.set("options", cfg.options);
  }
  return url.toString();
}

/**
 * Default `LegacyDbConnection` layer, backed by `@effect/sql-pg` (pure-JS `pg`
 * driver, no native addon — bundles under `bun build --compile`). Each
 * `connect` builds a scoped single-client connection that closes on scope exit.
 */
const connect = (
  cfg: LegacyPgConnInput,
  { isLocal }: LegacyDbConnectOptions,
): Effect.Effect<LegacyDbSession, LegacyDbConnectError, Scope.Scope> =>
  Effect.gen(function* () {
    const hasOptions = cfg.options !== undefined && cfg.options.length > 0;
    const client = yield* PgClient.make({
      // When a libpq `options` param is present, route everything through the
      // connection string so it reaches the server (see `buildConnectionUrl`);
      // otherwise pass discrete fields to avoid round-tripping the password.
      ...(hasOptions
        ? { url: Redacted.make(buildConnectionUrl(cfg)) }
        : {
            host: cfg.host,
            port: cfg.port,
            username: cfg.user,
            password: Redacted.make(cfg.password),
            database: cfg.database,
          }),
      // TLS parity with Go (`internal/utils/connect.go`): remote connections use
      // TLS (pgx `sslmode=prefer` with non-TLS fallbacks stripped) but do not
      // verify the certificate, while local connections disable TLS entirely
      // (`ConnectLocalPostgres` sets `cc.TLSConfig = nil`). Omitting `ssl` here
      // leaves the `pg` driver in plaintext mode — fine for local, but it would
      // break against SSL-enforcing remote Supabase databases.
      ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
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
