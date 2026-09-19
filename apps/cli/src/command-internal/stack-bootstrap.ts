import { Data, Effect, FileSystem, Path } from "effect";
import type { DatabaseInstance } from "@supabase/stack/effect";
import { Output } from "../shared/output/output.service.ts";
import { applyDatabaseWebhooks } from "./db-bootstrap/db-setup.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import { DbConnection, type DbSession } from "./db-connection.service.ts";
import type { DbTomlValues } from "./db-config.toml-read.ts";
import { migrateAndSeed } from "./migrate-and-seed.ts";

/** Failure while applying the CLI-owned database bootstrap steps. */
export class StackBootstrapError extends Data.TaggedError("StackBootstrapError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const databaseConn = Effect.fn("StackBootstrap.databaseConnection")(function* (
  database: DatabaseInstance,
) {
  const credentials = yield* database.credentials({ from: "host" });
  const conn = parseConnectionString(credentials.databaseUrl ?? "");
  if (conn === undefined)
    return yield* new StackBootstrapError({ message: "failed to parse stack database URL" });
  return conn;
});

const withDatabaseSession = <A, E, R>(
  database: DatabaseInstance,
  body: (session: DbSession) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dbConn = yield* DbConnection;
      const conn = yield* databaseConn(database);
      const session = yield* dbConn.connect(conn, { isLocal: true, dnsResolver: "native" });
      return yield* body(session);
    }),
  );

/** Applies only the webhook configuration to an already initialized database. */
export const applyStackWebhooksOnly = (
  database: DatabaseInstance,
  webhooksEnabled: boolean,
): Effect.Effect<void, StackBootstrapError, DbConnection | FileSystem.FileSystem | Path.Path> =>
  withDatabaseSession(database, (session) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-webhooks-" });
      yield* applyDatabaseWebhooks(session, fs, path, tmpDir, webhooksEnabled);
    }),
  ).pipe(
    Effect.mapError(
      (error) =>
        new StackBootstrapError({
          message:
            typeof error === "object" && error !== null && "message" in error
              ? String(error.message)
              : String(error),
          cause: error,
        }),
    ),
  );

/** Applies migrations and seeds after the stack catalog has initialized the database. */
export const applyStackMigrateAndSeed = (
  database: DatabaseInstance,
  workdir: string,
  toml: Pick<
    DbTomlValues,
    "migrationsEnabled" | "seed" | "pgDelta" | "schemaPaths" | "webhooksEnabled"
  >,
  experimental: boolean,
): Effect.Effect<
  void,
  StackBootstrapError,
  DbConnection | FileSystem.FileSystem | Path.Path | Output
> =>
  withDatabaseSession(database, (session) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* migrateAndSeed(session, fs, path, workdir, "", {
        migrationsEnabled: toml.migrationsEnabled,
        seed: toml.seed,
        experimental,
        pgDeltaEnabled: toml.pgDelta.enabled,
        schemaPaths: toml.schemaPaths,
        localDatabaseWebhooksEnabled: toml.webhooksEnabled,
      });
    }),
  ).pipe(
    Effect.mapError(
      (error) =>
        new StackBootstrapError({
          message:
            typeof error === "object" && error !== null && "message" in error
              ? String(error.message)
              : String(error),
          cause: error,
        }),
    ),
  );
