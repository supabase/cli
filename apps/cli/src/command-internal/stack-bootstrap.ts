import { Data, Effect, FileSystem, Path } from "effect";
import type { DatabaseInstance } from "@supabase/stack/effect";
import { Output } from "../shared/output/output.service.ts";
import { applyDatabaseWebhooks } from "./db-bootstrap/db-setup.ts";
import { parseConnectionString } from "./db-config.parse.ts";
import { DbConnection, type DbSession } from "./db-connection.service.ts";
import type { DbTomlValues } from "./db-config.toml-read.ts";
import { migrateAndSeed } from "./migrate-and-seed.ts";
import { StackCatalogSetup, type StackCatalogSetupInput } from "./stack-catalog-setup.ts";

/**
 * Failure while applying the CLI-owned database bootstrap steps: the database address is
 * `unavailable`, the connection failed (`connect`), or a bootstrap statement failed (`apply`).
 */
export class StackBootstrapError extends Data.TaggedError("StackBootstrapError")<{
  readonly reason: "unavailable" | "connect" | "apply";
  readonly message: string;
  readonly cause?: unknown;
}> {}

const bootstrapError =
  (reason: StackBootstrapError["reason"]) =>
  (error: unknown): StackBootstrapError =>
    new StackBootstrapError({
      reason,
      message:
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : String(error),
      cause: error,
    });

const databaseConn = Effect.fn("StackBootstrap.databaseConnection")(function* (
  database: DatabaseInstance,
) {
  const credentials = yield* database.credentials({ from: "host" });
  const conn = parseConnectionString(credentials.databaseUrl ?? "");
  if (conn === undefined)
    return yield* new StackBootstrapError({
      reason: "unavailable",
      message: "failed to parse stack database URL",
    });
  return conn;
});

const withDatabaseSession = <A, E, R>(
  database: DatabaseInstance,
  body: (session: DbSession) => Effect.Effect<A, E, R>,
  user?: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dbConn = yield* DbConnection;
      const conn = yield* databaseConn(database).pipe(
        Effect.catchTag("StackError", (cause) => Effect.fail(bootstrapError("unavailable")(cause))),
      );
      const session = yield* dbConn
        .connect(user === undefined ? conn : { ...conn, user }, {
          isLocal: true,
          dnsResolver: "native",
        })
        .pipe(Effect.mapError(bootstrapError("connect")));
      return yield* body(session).pipe(Effect.mapError(bootstrapError("apply")));
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
  );

/** Project migrations and seeds applied after the stack catalog. */
interface StackMigrations {
  readonly workdir: string;
  readonly toml: Pick<
    DbTomlValues,
    "migrationsEnabled" | "seed" | "pgDelta" | "schemaPaths" | "webhooksEnabled"
  >;
  readonly experimental: boolean;
  /** Applies migrations up to this version; omitted applies all of them. */
  readonly version?: string;
}

const applyStackMigrateAndSeed = (
  database: DatabaseInstance,
  migrations: StackMigrations,
): Effect.Effect<
  void,
  StackBootstrapError,
  DbConnection | FileSystem.FileSystem | Path.Path | Output
> =>
  withDatabaseSession(
    database,
    (session) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { toml } = migrations;
        yield* migrateAndSeed(session, fs, path, migrations.workdir, migrations.version ?? "", {
          migrationsEnabled: toml.migrationsEnabled,
          seed: toml.seed,
          experimental: migrations.experimental,
          pgDeltaEnabled: toml.pgDelta.enabled,
          schemaPaths: toml.schemaPaths,
          localDatabaseWebhooksEnabled: toml.webhooksEnabled,
        });
      }),
    "postgres",
  );

/** The catalog overlay declared by a project's `config.toml`. */
export const projectCatalogOverlay = (
  toml: Pick<DbTomlValues, "webhooksEnabled" | "baseline" | "vault">,
  workdir: string,
): StackCatalogSetupInput["overlay"] => ({
  webhooks: "config",
  webhooksEnabled: toml.webhooksEnabled,
  apiAutoExposeNewTables: toml.baseline.apiAutoExposeNewTables,
  vault: toml.vault,
  workdir,
});

/**
 * Initialises a started stack database: the catalog with its service schemas and overlay, then
 * the project migrations and seeds when requested.
 */
export const initializeStackDatabase = Effect.fn("StackBootstrap.initializeDatabase")(function* (
  input: StackCatalogSetupInput & { readonly migrations?: StackMigrations },
) {
  const catalog = yield* StackCatalogSetup;
  yield* catalog.apply({ target: input.target, overlay: input.overlay });
  if (input.migrations !== undefined)
    yield* applyStackMigrateAndSeed(input.target.database, input.migrations);
});
