import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeStandaloneService } from "../../tests/standalone-service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { makeDockerHttpRelay, makeDockerTcpRelay } from "../../tests/docker-relay.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";
import { engineTarget, testEngine } from "../../tests/engine-target.ts";
import { httpHost } from "../../tests/helpers/endpoint.ts";

const options = (root: string) => ({
  stackId: "catalog-realtime",
  instanceId: "instance",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "native" as const,
});

const dockerOptions = (root: string) => ({
  ...options(root),
  runtime: testEngine,
  engineTarget,
});

interface SharedDatabase {
  readonly root: string;
  readonly secret: string;
  readonly databaseUrl: string;
}

/** The one owned database shared by every case below; started once, stopped once. */
class CatalogDatabase extends Context.Service<CatalogDatabase, SharedDatabase>()(
  "Realtime.integration.CatalogDatabase",
) {}

const databaseLayer = Layer.effect(
  CatalogDatabase,
  Effect.gen(function* () {
    const root = yield* makeDockerDatabaseRoot("catalog-optional-api-");
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
    // Forked so the graceful stop below runs before the service's own scope closes.
    const serviceScope = yield* Scope.fork(yield* Effect.scope, "sequential");
    const database = yield* makeStandaloneService(databaseRecipe.definition, {
      id: "database",
      config: databaseRecipe.creation,
    }).pipe(Scope.provide(serviceScope));
    yield* database.start;
    yield* database.ready;
    yield* Effect.addFinalizer(() => database.stop.pipe(Effect.orDie));
    const databaseRelay = yield* makeDockerTcpRelay(databaseRecipe.endpoint("sql"));
    return {
      root,
      secret,
      databaseUrl: `postgresql://supabase_admin:postgres@${databaseRelay.host}:${databaseRelay.port}/postgres`,
    };
  }),
).pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)));

const startPgmeta = (root: string, databaseUrl: string) =>
  Effect.gen(function* () {
    const pgmetaRecipe = yield* makeServiceRecipe(
      { service: "pgmeta", config: { databaseUrl } },
      dockerOptions(root),
    );
    const pgmeta = yield* makeStandaloneService(pgmetaRecipe.definition, {
      id: "pgmeta",
      config: pgmetaRecipe.creation,
    });
    yield* pgmeta.start;
    yield* pgmeta.ready;
    return { pgmeta, pgmetaRecipe };
  });

layer(databaseLayer, { excludeTestServices: true })("service catalog", (it) => {
  it.effect(
    "serves Realtime against the owned database",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const { root, secret, databaseUrl } = yield* CatalogDatabase;
        const realtimeRecipe = yield* makeServiceRecipe(
          { service: "realtime", config: { databaseUrl, jwtSecret: secret } },
          dockerOptions(root),
        );
        const realtime = yield* makeStandaloneService(realtimeRecipe.definition, {
          id: "realtime",
          config: realtimeRecipe.creation,
        });
        yield* realtime.start;
        yield* realtime.ready;
        const realtimeEndpoint = yield* realtimeRecipe.endpoint("http");
        const realtimeResponse = yield* client.execute(
          HttpClientRequest.get(
            `http://${httpHost(realtimeEndpoint)}:${realtimeEndpoint.port}/healthcheck`,
          ),
        );
        expect(realtimeResponse.status).toBe(200);
        yield* realtime.stop;
      }),
    { timeout: 120_000 },
  );

  it.effect(
    "serves pg-meta against the owned database",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const { root, databaseUrl } = yield* CatalogDatabase;
        const { pgmeta, pgmetaRecipe } = yield* startPgmeta(root, databaseUrl);
        const pgmetaEndpoint = yield* pgmetaRecipe.endpoint("http");
        const schemasResponse = yield* client.execute(
          HttpClientRequest.get(
            `http://${httpHost(pgmetaEndpoint)}:${pgmetaEndpoint.port}/schemas`,
          ),
        );
        expect(schemasResponse.status).toBe(200);
        expect(yield* schemasResponse.text).toContain("public");
        yield* pgmeta.stop;
      }),
    { timeout: 120_000 },
  );

  it.effect(
    "serves Studio backed by pg-meta against the owned database",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const { root, secret, databaseUrl } = yield* CatalogDatabase;
        const { pgmeta, pgmetaRecipe } = yield* startPgmeta(root, databaseUrl);
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
        const studio = yield* makeStandaloneService(studioRecipe.definition, {
          id: "studio",
          config: studioRecipe.creation,
        });
        yield* studio.start;
        yield* studio.ready;
        const studioEndpoint = yield* studioRecipe.endpoint("http");
        const profileResponse = yield* client.execute(
          HttpClientRequest.get(
            `http://${httpHost(studioEndpoint)}:${studioEndpoint.port}/api/platform/profile`,
          ),
        );
        expect(profileResponse.status).toBe(200);
        const queryResponse = yield* client.execute(
          HttpClientRequest.post(
            `http://${httpHost(studioEndpoint)}:${studioEndpoint.port}/api/platform/pg-meta/default/query`,
          ).pipe(HttpClientRequest.bodyJsonUnsafe({ query: "select current_user" })),
        );
        expect(queryResponse.status).toBe(200);
        expect(yield* queryResponse.text).toContain('"current_user":"postgres"');

        yield* studio.stop;
        yield* pgmeta.stop;
      }),
    { timeout: 120_000 },
  );
});
