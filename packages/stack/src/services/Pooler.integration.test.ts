import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Redacted, Scope } from "effect";
import { PgClient } from "@effect/sql-pg";
import { makeService, type ServiceInstance } from "../Service.ts";
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

const secret = "catalog-pooler-secret-with-at-least-32-chars";

let scope: Scope.Closeable;
let setupFiber: Fiber.Fiber<void, never>;
let database: ServiceInstance<any> | undefined;
let root: string;
let nativeDatabaseUrl: string;
let dockerDatabaseUrl: string;

describe("service catalog", () => {
  beforeAll(() => {
    scope = Scope.makeUnsafe();
    const setup = Effect.gen(function* () {
      const databaseRoot = yield* makeDockerDatabaseRoot("catalog-pooler-");
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
        dockerOptions(databaseRoot),
      );
      const databaseService = yield* makeService(databaseRecipe.definition, {
        id: "database",
        config: databaseRecipe.creation,
      });
      // Assigned before start so afterAll can still stop it if a later step fails.
      database = databaseService;
      yield* databaseService.start;
      yield* databaseService.ready;
      const databaseEndpoint = yield* databaseRecipe.endpoint("sql");
      if (databaseEndpoint.kind !== "tcp" || databaseEndpoint.host === undefined)
        return yield* new ProxyError({ message: "Docker database did not expose TCP" });
      const databaseRelay = yield* makeDockerTcpRelay(databaseRecipe.endpoint("sql"));
      root = databaseRoot;
      dockerDatabaseUrl = `postgresql://supabase_admin:postgres@${databaseRelay.host}:${databaseRelay.port}/_supabase`;
      nativeDatabaseUrl = `postgresql://supabase_admin:postgres@${databaseEndpoint.host}:${databaseEndpoint.port}/_supabase`;
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
      Scope.provide(scope),
      Effect.orDie,
    );
    setupFiber = Effect.runFork(setup);
    return Fiber.join(setupFiber).pipe(Effect.runPromise);
  }, 120_000);

  afterAll(
    () =>
      Fiber.interrupt(setupFiber).pipe(
        Effect.andThen(() => (database === undefined ? Effect.void : Effect.ignore(database.stop))),
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.runPromise,
      ),
    60_000,
  );

  for (const runtime of ["native", "docker"] as const) {
    for (const poolMode of ["transaction", "session"] as const) {
      it.live(
        `serves Pooler SQL against the owned database (${runtime} runtime, ${poolMode} pool mode)`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const tenant = `catalog-${runtime}-${poolMode}`;
              const poolerRecipe = yield* makeServiceRecipe(
                {
                  service: "pooler",
                  config: {
                    databaseUrl: runtime === "native" ? nativeDatabaseUrl : dockerDatabaseUrl,
                    jwtSecret: secret,
                    tenant,
                    poolMode,
                    defaultPoolSize: 7,
                    maxClientConnections: 42,
                  },
                },
                runtime === "native" ? options(root) : dockerOptions(root),
              );
              const pooler = yield* makeService(poolerRecipe.definition, {
                id: `pooler-${runtime}-${poolMode}`,
                config: poolerRecipe.creation,
              });
              for (const phase of runtime === "native" ? ["start", "restart"] : ["start"]) {
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
            }),
          ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
        { timeout: 120_000 },
      );
    }
  }
});
