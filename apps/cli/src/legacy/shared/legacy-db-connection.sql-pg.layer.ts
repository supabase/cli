import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted, type Scope } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { LegacyDbConnectError, LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "./legacy-db-connection.service.ts";

/**
 * Default `LegacyDbConnection` layer, backed by `@effect/sql-pg` (pure-JS `pg`
 * driver, no native addon — bundles under `bun build --compile`). Each
 * `connect` builds a scoped single-client connection that closes on scope exit.
 */
const connect = (
  cfg: LegacyPgConnInput,
): Effect.Effect<LegacyDbSession, LegacyDbConnectError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* PgClient.make({
      host: cfg.host,
      port: cfg.port,
      username: cfg.user,
      password: Redacted.make(cfg.password),
      database: cfg.database,
      maxConnections: 1,
    }).pipe(
      Effect.provide(Reactivity.layer),
      Effect.mapError(
        (error) => new LegacyDbConnectError({ message: `failed to connect to postgres: ${error}` }),
      ),
    );

    const session: LegacyDbSession = {
      exec: (sql) =>
        client.unsafe(sql).pipe(
          Effect.asVoid,
          Effect.mapError((error) => new LegacyDbExecError({ message: String(error) })),
        ),
      extensionExists: (schema, name) =>
        client`select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = ${name} and n.nspname = ${schema}`.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError((error) => new LegacyDbExecError({ message: String(error) })),
        ),
    };
    return session;
  });

export const legacyDbConnectionSqlPgLayer = Layer.succeed(LegacyDbConnection, { connect });
