import { PgClient } from "@effect/sql-pg";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { tmpdir } from "node:os";
import { Context, Crypto, Effect, FileSystem, Layer, Redacted, Schedule } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeService } from "../Service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import type { ServiceEndpoint } from "./Recipe.ts";
import { makeDockerHttpRelay, makeDockerTcpRelay } from "../../tests/docker-relay.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";

const options = (root: string, runtime: "docker" | "native") => ({
  stackId: "catalog-test",
  instanceId: "vector",
  root,
  cacheRoot: `${tmpdir()}/supabase-stack-artifacts`,
  runtime,
});

const password = Redacted.make("postgres");

const query = <A extends object>(endpoint: ServiceEndpoint, database: string, statement: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        PgClient.layer({
          host: endpoint.host ?? "127.0.0.1",
          port: endpoint.port,
          database,
          username: "supabase_admin",
          password,
        }),
      );
      return yield* Context.get(services, PgClient.PgClient).unsafe<A>(statement);
    }),
  );

describe("vector recipe", () => {
  for (const runtime of ["docker", "native"] as const) {
    it.live(
      `serves health without a custom config and cleans up on destroy, including interrupted writes (${runtime})`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const client = yield* HttpClient.HttpClient;
            const root = yield* fs.makeTempDirectoryScoped({
              prefix: `catalog-vector-${runtime}-`,
            });
            const recipe = yield* makeServiceRecipe(
              {
                service: "vector",
                config: { analyticsUrl: "http://analytics", apiKey: "api-key" },
                endpoints: { http: { port: "auto" } },
              },
              options(root, runtime),
            );
            const vector = yield* makeService(recipe.definition, {
              id: "vector",
              config: recipe.creation,
            });
            yield* vector.start;
            yield* vector.ready;
            const endpoint = yield* recipe.endpoint("http");
            const response = yield* client.execute(
              HttpClientRequest.get(`http://${endpoint.host}:${endpoint.port}/health`),
            );
            expect(response.status).toBe(200);
            yield* fs.makeDirectory(`${root}/vector/runtime/vector/.vector-write-interrupted`);
            yield* vector.destroy;
            expect(yield* fs.exists(`${root}/vector`)).toBe(false);
          }),
        ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
      { timeout: 120_000 },
    );
  }

  it.live(
    "keeps a caller pipeline stored beside the recipe config on destroy",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-vector-caller-" });
          const pipeline = `${root}/vector/runtime/vector/pipeline.yaml`;
          yield* fs.makeDirectory(`${root}/vector/runtime/vector`, { recursive: true });
          yield* fs.writeFileString(
            pipeline,
            "sources:\n  s:\n    type: internal_logs\nsinks:\n  d:\n    type: blackhole\n    inputs: [s]\n",
          );
          const recipe = yield* makeServiceRecipe(
            {
              service: "vector",
              config: { analyticsUrl: "http://analytics", configPath: pipeline },
              endpoints: { http: { port: "auto" } },
            },
            options(root, "docker"),
          );
          const vector = yield* makeService(recipe.definition, {
            id: "vector",
            config: recipe.creation,
          });
          yield* vector.start;
          yield* vector.ready;
          yield* vector.destroy;
          expect(yield* fs.exists(pipeline)).toBe(true);
          expect(yield* fs.exists(`${root}/vector/runtime/vector/vector-api.yaml`)).toBe(false);
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );

  it.live("rejects a caller pipeline that resolves to a stack-owned config file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-vector-reject-" });
        const owned = `${root}/vector/runtime/vector/vector-api.yaml`;
        yield* fs.makeDirectory(`${root}/vector/runtime/vector`, { recursive: true });
        yield* fs.writeFileString(owned, "api:\n  enabled: true\n");
        yield* fs.symlink(owned, `${root}/alias.yaml`);
        const start = (configPath: string) =>
          Effect.gen(function* () {
            const recipe = yield* makeServiceRecipe(
              {
                service: "vector",
                config: { analyticsUrl: "http://analytics", configPath },
                endpoints: { http: { port: "auto" } },
              },
              options(root, "docker"),
            );
            const vector = yield* makeService(recipe.definition, {
              id: "vector",
              config: recipe.creation,
            });
            return yield* vector.start.pipe(Effect.flip);
          });
        for (const configPath of [owned, `${root}/alias.yaml`])
          expect((yield* start(configPath)).message).toContain("stack-owned Vector config file");
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

  it.live(
    "ships the stack's service logs to Analytics with its default pipeline",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const id = yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));
          const marker = `vector-pipeline-${id.slice(0, 8)}`;
          const options = {
            stackId: marker,
            instanceId: "instance",
            root: yield* makeDockerDatabaseRoot("vector-pipeline-", marker),
            runtime: "docker" as const,
          };
          const catalogOptions = { ...options, cacheRoot: `${options.root}/cache` };
          const databaseRecipe = yield* makeServiceRecipe(
            {
              service: "database",
              config: {
                version: "17",
                databasePassword: password,
                jwtSecret: Redacted.make("vector-pipeline-secret-with-at-least-32-chars"),
                jwtExpiry: 3600,
              },
            },
            catalogOptions,
          );
          const database = yield* makeService(databaseRecipe.definition, {
            id: "database",
            config: databaseRecipe.creation,
          });
          yield* database.start;
          yield* database.ready;
          const sql = yield* databaseRecipe.endpoint("sql");
          const databaseRelay = yield* makeDockerTcpRelay(databaseRecipe.endpoint("sql"));

          const analyticsRecipe = yield* makeServiceRecipe(
            {
              service: "analytics",
              config: {
                databaseUrl: `postgresql://supabase_admin:postgres@${databaseRelay.host}:${databaseRelay.port}/_supabase`,
                backend: "postgres",
                apiKey: "vector-pipeline-key",
              },
            },
            catalogOptions,
          );
          const analytics = yield* makeService(analyticsRecipe.definition, {
            id: "analytics",
            config: analyticsRecipe.creation,
          });
          yield* analytics.start;
          yield* analytics.ready;
          const analyticsRelay = yield* makeDockerHttpRelay(analyticsRecipe.endpoint("http"));

          const vectorRecipe = yield* makeServiceRecipe(
            {
              service: "vector",
              config: {
                analyticsUrl: `http://${analyticsRelay.host}:${analyticsRelay.port}`,
                apiKey: "vector-pipeline-key",
              },
            },
            catalogOptions,
          );
          const vector = yield* makeService(vectorRecipe.definition, {
            id: "vector",
            config: vectorRecipe.creation,
          });
          yield* vector.start;
          yield* vector.ready;

          yield* query(sql, "postgres", `DO $$ BEGIN RAISE LOG '${marker}'; END $$`);

          const [source] = yield* query<{ readonly token: string }>(
            sql,
            "_supabase",
            "SELECT replace(token::text, '-', '_') AS token FROM _analytics.sources WHERE name = 'postgres.logs'",
          );
          const events = `_analytics."log_events_${source?.token}"`;
          // Vector batches and Logflare inserts asynchronously, with no completion signal to await.
          const shipped = yield* query<{ readonly message: string; readonly severity: string }>(
            sql,
            "_supabase",
            `SELECT body->>'event_message' AS message, body->'metadata'->'parsed'->>'error_severity' AS severity FROM ${events} WHERE body->>'event_message' LIKE '%LOG:  ${marker}'`,
          ).pipe(
            Effect.filterOrFail((rows) => rows.length > 0),
            Effect.retry(Schedule.spaced("500 millis")),
            Effect.timeout("60 seconds"),
          );
          expect(shipped).toEqual([
            { message: expect.stringContaining(`LOG:  ${marker}`), severity: "LOG" },
          ]);

          yield* vector.stop;
          yield* analytics.stop;
          yield* database.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 180_000 },
  );
});
