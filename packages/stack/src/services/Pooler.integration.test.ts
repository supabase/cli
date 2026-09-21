import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { makeService } from "../Service.ts";
import { ProxyError } from "../Proxy.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { makeDockerTcpRelay } from "../../tests/docker-relay.ts";
import { cleanupDockerRoot } from "../../tests/docker-cleanup.ts";

const options = (root: string) => ({
  stackId: "catalog-test",
  instanceId: "instance",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "native" as const,
});

const dockerOptions = (root: string) => ({
  ...options(root),
  runtime: "docker" as const,
});

describe("service catalog", () => {
  it.live(
    "serves Pooler SQL against the owned database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-pooler-" });
          yield* Effect.addFinalizer(() => cleanupDockerRoot(root));
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
          const database = yield* makeService(databaseRecipe.definition, {
            id: "database",
            config: databaseRecipe.creation,
          });
          yield* database.start;
          yield* database.ready;
          const databaseEndpoint = yield* databaseRecipe.endpoint("sql");
          if (databaseEndpoint.kind !== "tcp" || databaseEndpoint.host === undefined)
            return yield* new ProxyError({ message: "Docker database did not expose TCP" });
          const databaseRelay = yield* makeDockerTcpRelay(databaseRecipe.endpoint("sql"));
          const databaseUrl = `postgresql://supabase_admin:postgres@${databaseRelay.host}:${databaseRelay.port}/_supabase`;
          for (const poolMode of ["transaction", "session"] as const) {
            const tenant = `catalog-${poolMode}`;
            const poolerRecipe = yield* makeServiceRecipe(
              {
                service: "pooler",
                config: { databaseUrl, jwtSecret: secret, tenant, poolMode },
              },
              dockerOptions(root),
            );
            const pooler = yield* makeService(poolerRecipe.definition, {
              id: `pooler-${poolMode}`,
              config: poolerRecipe.creation,
            });
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
            yield* pooler.stop;
          }
          yield* database.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
});
