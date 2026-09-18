import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeService } from "../Service.ts";
import { ProxyError } from "../Proxy.ts";
import { makeServiceRecipe } from "./Catalog.ts";

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
    "serves Realtime, pg-meta, and Studio against the owned database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* HttpClient.HttpClient;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-optional-api-" });
          const secret = "catalog-optional-api-secret-with-at-least-32-chars";
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
          const databaseUrl = `postgresql://supabase_admin:postgres@host.docker.internal:${databaseEndpoint.port}/postgres`;

          const realtimeRecipe = yield* makeServiceRecipe(
            { service: "realtime", config: { databaseUrl, jwtSecret: secret } },
            dockerOptions(root),
          );
          const realtime = yield* makeService(realtimeRecipe.definition, {
            id: "realtime",
            config: realtimeRecipe.creation,
          });
          yield* realtime.start;
          yield* realtime.ready;
          const realtimeEndpoint = yield* realtimeRecipe.endpoint("http");
          const realtimeResponse = yield* client.execute(
            HttpClientRequest.get(
              `http://${realtimeEndpoint.host}:${realtimeEndpoint.port}/healthcheck`,
            ),
          );
          expect(realtimeResponse.status).toBe(200);

          const pgmetaRecipe = yield* makeServiceRecipe(
            { service: "pgmeta", config: { databaseUrl } },
            dockerOptions(root),
          );
          const pgmeta = yield* makeService(pgmetaRecipe.definition, {
            id: "pgmeta",
            config: pgmetaRecipe.creation,
          });
          yield* pgmeta.start;
          yield* pgmeta.ready;
          const pgmetaEndpoint = yield* pgmetaRecipe.endpoint("http");
          const schemasResponse = yield* client.execute(
            HttpClientRequest.get(`http://${pgmetaEndpoint.host}:${pgmetaEndpoint.port}/schemas`),
          );
          expect(schemasResponse.status).toBe(200);
          expect(yield* schemasResponse.text).toContain("public");

          const studioRecipe = yield* makeServiceRecipe(
            {
              service: "studio",
              config: {
                pgmetaUrl: `http://host.docker.internal:${pgmetaEndpoint.port}`,
                analyticsApiKey: "catalog-analytics-key",
                apiUrl: "http://localhost:8000",
                publicApiUrl: "http://localhost:8000",
                jwtSecret: secret,
              },
            },
            dockerOptions(root),
          );
          const studio = yield* makeService(studioRecipe.definition, {
            id: "studio",
            config: studioRecipe.creation,
          });
          yield* studio.start;
          yield* studio.ready;
          const studioEndpoint = yield* studioRecipe.endpoint("http");
          const profileResponse = yield* client.execute(
            HttpClientRequest.get(
              `http://${studioEndpoint.host}:${studioEndpoint.port}/api/platform/profile`,
            ),
          );
          expect(profileResponse.status).toBe(200);

          yield* studio.stop;
          yield* pgmeta.stop;
          yield* realtime.stop;
          yield* database.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
});
