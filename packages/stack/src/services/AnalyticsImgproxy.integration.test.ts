import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Redacted, Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeStandaloneService } from "../../tests/standalone-service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { makeDockerTcpRelay } from "../../tests/docker-relay.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";
import { httpHost } from "../../tests/helpers/endpoint.ts";
import { engineTarget, testEngine } from "../../tests/engine-target.ts";

const options = (root: string) => ({
  stackId: "catalog-analytics",
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
  readonly databaseUrl: string;
}

/** The one owned database shared by every case below; started once, stopped once. */
class CatalogDatabase extends Context.Service<CatalogDatabase, SharedDatabase>()(
  "AnalyticsImgproxy.integration.CatalogDatabase",
) {}

const databaseLayer = Layer.effect(
  CatalogDatabase,
  Effect.gen(function* () {
    const root = yield* makeDockerDatabaseRoot("catalog-optional-data-");
    const secret = "catalog-optional-data-secret-with-at-least-32-chars";
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
      databaseUrl: `postgresql://supabase_admin:postgres@${databaseRelay.host}:${databaseRelay.port}/postgres`,
    };
  }),
).pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)));

layer(databaseLayer, { excludeTestServices: true })("service catalog", (it) => {
  it.effect(
    "serves Analytics with its real endpoint",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const { root, databaseUrl } = yield* CatalogDatabase;
        const analyticsRecipe = yield* makeServiceRecipe(
          {
            service: "analytics",
            config: { databaseUrl, backend: "postgres", apiKey: "catalog-analytics" },
          },
          dockerOptions(root),
        );
        const analytics = yield* makeStandaloneService(analyticsRecipe.definition, {
          id: "analytics",
          config: analyticsRecipe.creation,
        });
        yield* analytics.start;
        yield* analytics.ready;
        const analyticsEndpoint = yield* analyticsRecipe.endpoint("http");
        const analyticsResponse = yield* client.execute(
          HttpClientRequest.get(
            `http://${httpHost(analyticsEndpoint)}:${analyticsEndpoint.port}/health`,
          ),
        );
        expect(analyticsResponse.status).toBe(200);
        yield* analytics.stop;
      }),
    { timeout: 120_000 },
  );

  it.effect(
    "serves Imgproxy with its real endpoint",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const client = yield* HttpClient.HttpClient;
        const { root } = yield* CatalogDatabase;
        // Ownership is by location: Imgproxy's served directory is a caller path and must live
        // outside the stack's data root, not merely outside the service's own instance root.
        const callerRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "catalog-optional-data-caller-",
        });
        const imageRoot = `${callerRoot}/images`;
        yield* fs.makeDirectory(imageRoot, { recursive: true });
        const imgproxyRecipe = yield* makeServiceRecipe(
          { service: "imgproxy", config: { filePath: imageRoot } },
          dockerOptions(root),
        );
        const imgproxy = yield* makeStandaloneService(imgproxyRecipe.definition, {
          id: "imgproxy",
          config: imgproxyRecipe.creation,
        });
        yield* imgproxy.start;
        yield* imgproxy.ready;
        const imgproxyEndpoint = yield* imgproxyRecipe.endpoint("http");
        const imgproxyResponse = yield* client.execute(
          HttpClientRequest.get(
            `http://${httpHost(imgproxyEndpoint)}:${imgproxyEndpoint.port}/health`,
          ),
        );
        expect(imgproxyResponse.status).toBe(200);
        yield* imgproxy.stop;
      }),
    { timeout: 120_000 },
  );
});
