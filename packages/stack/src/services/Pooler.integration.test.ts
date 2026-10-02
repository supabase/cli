import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Scope } from "effect";
import { PgClient } from "@effect/sql-pg";
import { makeService } from "../Service.ts";
import { ProxyError } from "../Proxy.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { makeDockerTcpRelay } from "../../tests/docker-relay.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";

const options = (root: string) => ({
  stackId: "catalog-pooler",
  instanceId: "instance",
  root,
  cacheRoot: "/tmp/supabase-stack-artifacts",
  runtime: "native" as const,
});

const dockerOptions = (root: string) => ({
  ...options(root),
  cacheRoot: `${root}/cache`,
  runtime: "docker" as const,
});

interface SharedDatabase {
  readonly root: string;
  readonly secret: string;
  readonly nativeDatabaseUrl: string;
  readonly dockerDatabaseUrl: string;
}

/** The one owned database shared by every pooler case below; started once, stopped once. */
class PoolerDatabase extends Context.Service<PoolerDatabase, SharedDatabase>()(
  "Pooler.integration.PoolerDatabase",
) {}

const databaseLayer = Layer.effect(
  PoolerDatabase,
  Effect.gen(function* () {
    const root = yield* makeDockerDatabaseRoot("catalog-pooler-");
    const secret = "catalog-pooler-secret-with-at-least-32-chars";
    const databaseRecipe = yield* makeServiceRecipe(
      {
        service: "database",
        config: {
          version: "17",
          databasePassword: Redacted.make("postgres"),
          jwtSecret: Redacted.make(secret),
          jwtExpiry: 3600,
        },
      },
      dockerOptions(root),
    );
    // Forked so the graceful `database.stop` below can still run normally once this layer's
    // own scope starts closing: scope finalizers run in reverse (LIFO) order of registration,
    // so the fork's auto-registered close finalizer runs after ours, not concurrently with it.
    const serviceScope = yield* Scope.fork(yield* Effect.scope, "sequential");
    const database = yield* makeService(databaseRecipe.definition, {
      id: "database",
      config: databaseRecipe.creation,
    }).pipe(Scope.provide(serviceScope));
    yield* database.start;
    yield* database.ready;
    yield* Effect.addFinalizer(() => database.stop.pipe(Effect.orDie));
    const databaseEndpoint = yield* databaseRecipe.endpoint("sql");
    if (databaseEndpoint.kind !== "tcp" || databaseEndpoint.host === undefined)
      return yield* new ProxyError({ message: "Docker database did not expose TCP" });
    const databaseRelay = yield* makeDockerTcpRelay(databaseRecipe.endpoint("sql"));
    return {
      root,
      secret,
      nativeDatabaseUrl: `postgresql://supabase_admin:postgres@${databaseEndpoint.host}:${databaseEndpoint.port}/_supabase`,
      dockerDatabaseUrl: `postgresql://supabase_admin:postgres@${databaseRelay.host}:${databaseRelay.port}/_supabase`,
    };
  }),
).pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)));

/** Exercises one (runtime, poolMode) pooler against the shared database, restarting native poolers. */
const servesPoolerSql = (params: {
  readonly runtime: "native" | "docker";
  readonly poolMode: "transaction" | "session";
}) =>
  Effect.gen(function* () {
    const { runtime, poolMode } = params;
    const database = yield* PoolerDatabase;
    const tenant = `catalog-${runtime}-${poolMode}`;
    const poolerRecipe = yield* makeServiceRecipe(
      {
        service: "pooler",
        config: {
          databaseUrl:
            runtime === "native" ? database.nativeDatabaseUrl : database.dockerDatabaseUrl,
          jwtSecret: database.secret,
          tenant,
          poolMode,
          defaultPoolSize: 7,
          maxClientConnections: 42,
        },
      },
      runtime === "native" ? options(database.root) : dockerOptions(database.root),
    );
    const pooler = yield* makeService(poolerRecipe.definition, {
      id: `pooler-${runtime}-${poolMode}`,
      config: poolerRecipe.creation,
    });
    for (const phase of runtime === "native"
      ? (["start", "restart"] as const)
      : (["start"] as const)) {
      if (phase === "restart") {
        yield* pooler.stop;
      }
      yield* pooler.start;
      yield* pooler.ready;
      const sqlEndpoint = yield* poolerRecipe.endpoint("sql");
      if (sqlEndpoint.kind !== "tcp" || sqlEndpoint.host === undefined)
        return yield* new ProxyError({ message: "Pooler did not expose TCP" });
      const poolerLayer = yield* Layer.build(
        PgClient.layer({
          host: sqlEndpoint.host,
          port: sqlEndpoint.port,
          database: "postgres",
          username: `supabase_admin.${tenant}`,
          password: Redacted.make("postgres"),
        }),
      );
      const sql = Context.get(poolerLayer, PgClient.PgClient);
      const rows = yield* sql.unsafe<{ readonly value: number }>("SELECT 1 AS value");
      expect(rows[0]?.value).toBe(1);
    }
    yield* pooler.stop;
  });

layer(databaseLayer, { excludeTestServices: true })("service catalog", (it) => {
  it.effect(
    "serves Pooler SQL in transaction mode on the native runtime, across a restart",
    () => servesPoolerSql({ runtime: "native", poolMode: "transaction" }),
    { timeout: 120_000 },
  );

  it.effect(
    "serves Pooler SQL in session mode on the native runtime, across a restart",
    () => servesPoolerSql({ runtime: "native", poolMode: "session" }),
    { timeout: 120_000 },
  );

  it.effect(
    "serves Pooler SQL in transaction mode on the docker runtime",
    () => servesPoolerSql({ runtime: "docker", poolMode: "transaction" }),
    { timeout: 120_000 },
  );

  it.effect(
    "serves Pooler SQL in session mode on the docker runtime",
    () => servesPoolerSql({ runtime: "docker", poolMode: "session" }),
    { timeout: 120_000 },
  );
});
