import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Redacted, Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeService, type ServiceInstance } from "../Service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { makeDockerHttpRelay, makeDockerTcpRelay } from "../../tests/docker-relay.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";

const options = (root: string) => ({
  stackId: "catalog-realtime",
  instanceId: "instance",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "native" as const,
});

const dockerOptions = (root: string) => ({
  ...options(root),
  runtime: "docker" as const,
});

const secret = "catalog-optional-api-secret-with-at-least-32-chars";

let scope: Scope.Closeable;
let setupFiber: Fiber.Fiber<void, never>;
let database: ServiceInstance<any> | undefined;
let root: string;
let databaseUrl: string;

describe("service catalog", () => {
  beforeAll(() => {
    scope = Scope.makeUnsafe();
    const setup = Effect.gen(function* () {
      const databaseRoot = yield* makeDockerDatabaseRoot("catalog-optional-api-");
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
      const databaseRelay = yield* makeDockerTcpRelay(databaseRecipe.endpoint("sql"));
      root = databaseRoot;
      databaseUrl = `postgresql://supabase_admin:postgres@${databaseRelay.host}:${databaseRelay.port}/postgres`;
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

  it.live(
    "serves Realtime against the owned database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
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
          yield* realtime.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );

  it.live(
    "serves pg-meta against the owned database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
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
          yield* pgmeta.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );

  it.live(
    "serves Studio backed by pg-meta against the owned database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
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
          const pgmetaRelay = yield* makeDockerHttpRelay(pgmetaRecipe.endpoint("http"));

          const studioRecipe = yield* makeServiceRecipe(
            {
              service: "studio",
              config: {
                databaseUrl,
                pgmetaUrl: `http://${pgmetaRelay.host}:${pgmetaRelay.port}`,
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
          const queryResponse = yield* client.execute(
            HttpClientRequest.post(
              `http://${studioEndpoint.host}:${studioEndpoint.port}/api/platform/pg-meta/default/query`,
            ).pipe(HttpClientRequest.bodyJsonUnsafe({ query: "select current_user" })),
          );
          expect(queryResponse.status).toBe(200);
          expect(yield* queryResponse.text).toContain('"current_user":"postgres"');

          yield* studio.stop;
          yield* pgmeta.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
});
