import { NodeCrypto, NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { makeStandaloneService } from "../../tests/standalone-service.ts";
import { ProxyError } from "../Proxy.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { makeDockerTcpRelay } from "../../tests/docker-relay.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";
import { engineTarget, testEngine } from "../../tests/engine-target.ts";
import { testArtifactCacheRoot } from "../../tests/artifact-cache.ts";
import { selection } from "../../tests/pins.ts";
import { phaseDeadline } from "../../tests/phase-deadline.ts";

const options = (root: string) => ({
  stackId: "catalog-pooler",
  instanceId: "instance",
  root,
  cacheRoot: testArtifactCacheRoot,
  runtime: "native" as const,
  claimNativePort: () => Effect.succeed(true),
});

const dockerOptions = (root: string) => ({
  ...options(root),
  cacheRoot: `${root}/cache`,
  runtime: testEngine,
  engineTarget,
});

describe("service catalog", () => {
  it.live(
    "serves Pooler SQL against the owned database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeDockerDatabaseRoot("catalog-pooler-");
          const secret = "catalog-pooler-secret-with-at-least-32-chars";
          const databaseRecipe = yield* makeServiceRecipe(
            {
              service: "database",
              pin: selection.database,
              config: {
                databasePassword: Redacted.make("postgres"),
                jwtSecret: Redacted.make(secret),
                jwtExpiry: 3600,
              },
            },
            dockerOptions(root),
          );
          const database = yield* makeStandaloneService(databaseRecipe.definition, {
            id: "database",
            config: databaseRecipe.creation,
          });
          yield* database.start.pipe(phaseDeadline("database start", 75));
          yield* database.ready.pipe(phaseDeadline("database readiness", 30));
          const databaseEndpoint = yield* databaseRecipe.endpoint("sql");
          if (databaseEndpoint.kind !== "tcp" || databaseEndpoint.host === undefined)
            return yield* new ProxyError({ message: "Docker database did not expose TCP" });
          const databaseRelay = yield* makeDockerTcpRelay(databaseRecipe.endpoint("sql")).pipe(
            phaseDeadline("database relay", 15),
          );
          const dockerDatabaseUrl = `postgresql://supabase_admin:postgres@${databaseRelay.host}:${databaseRelay.port}/_supabase`;
          const nativeDatabaseUrl = `postgresql://supabase_admin:postgres@${databaseEndpoint.host}:${databaseEndpoint.port}/_supabase`;
          for (const runtime of ["native", testEngine] as const) {
            for (const poolMode of ["transaction", "session"] as const) {
              const tenant = `catalog-${runtime}-${poolMode}`;
              const poolerRecipe = yield* makeServiceRecipe(
                {
                  service: "pooler",
                  pin: selection.pooler,
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
              const pooler = yield* makeStandaloneService(poolerRecipe.definition, {
                id: `pooler-${runtime}-${poolMode}`,
                config: poolerRecipe.creation,
              });
              for (const phase of runtime === "native" ? ["start", "restart"] : ["start"]) {
                const step = `${runtime} ${poolMode} pooler ${phase}`;
                if (phase === "restart") {
                  yield* pooler.stop.pipe(phaseDeadline(`${step} stop`, 15));
                }
                yield* pooler.start.pipe(phaseDeadline(`${step} start`, 60));
                yield* pooler.ready.pipe(phaseDeadline(`${step} readiness`, 30));
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
                ).pipe(phaseDeadline(`${step} client connect`, 15));
                const sql = Context.get(poolerLayer, PgClient.PgClient);
                const rows = yield* sql
                  .unsafe<{ readonly value: number }>("SELECT 1 AS value")
                  .pipe(phaseDeadline(`${step} query`, 15));
                expect(rows[0]?.value).toBe(1);
              }
              yield* pooler.stop.pipe(phaseDeadline(`${runtime} ${poolMode} pooler stop`, 15));
            }
          }
          yield* database.stop.pipe(phaseDeadline("database stop", 15));
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NodeHttpClient.layerNodeHttp),
        ),
      ),
    { timeout: 120_000 },
  );
});
