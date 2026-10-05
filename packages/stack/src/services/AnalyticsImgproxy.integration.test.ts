import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, FileSystem, Layer, Redacted, Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeService, type ServiceInstance } from "../Service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { makeDockerTcpRelay } from "../../tests/docker-relay.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";

const options = (root: string) => ({
  stackId: "catalog-analytics",
  instanceId: "instance",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "native" as const,
});

const dockerOptions = (root: string) => ({
  ...options(root),
  runtime: "docker" as const,
});

const secret = "catalog-optional-data-secret-with-at-least-32-chars";

let scope: Scope.Closeable;
let setupFiber: Fiber.Fiber<void, never>;
let database: ServiceInstance<any> | undefined;
let root: string;
let databaseUrl: string;

describe("service catalog", () => {
  beforeAll(() => {
    scope = Scope.makeUnsafe();
    const setup = Effect.gen(function* () {
      const databaseRoot = yield* makeDockerDatabaseRoot("catalog-optional-data-");
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
        Effect.succeed([]),
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
        Effect.andThen(() => (database === undefined ? Effect.void : database.stop)),
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.runPromise,
      ),
    60_000,
  );

  it.live(
    "serves Analytics with its real endpoint",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const analyticsRecipe = yield* makeServiceRecipe(
            {
              service: "analytics",
              config: { databaseUrl, backend: "postgres", apiKey: "catalog-analytics" },
            },
            dockerOptions(root),
            Effect.succeed([]),
          );
          const analytics = yield* makeService(analyticsRecipe.definition, {
            id: "analytics",
            config: analyticsRecipe.creation,
          });
          yield* analytics.start;
          yield* analytics.ready;
          const analyticsEndpoint = yield* analyticsRecipe.endpoint("http");
          const analyticsResponse = yield* client.execute(
            HttpClientRequest.get(
              `http://${analyticsEndpoint.host}:${analyticsEndpoint.port}/health`,
            ),
          );
          expect(analyticsResponse.status).toBe(200);
          yield* analytics.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );

  it.live(
    "serves Imgproxy with its real endpoint",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* HttpClient.HttpClient;
          const imageRoot = `${root}/images`;
          yield* fs.makeDirectory(imageRoot, { recursive: true });
          const imgproxyRecipe = yield* makeServiceRecipe(
            { service: "imgproxy", config: { filePath: imageRoot } },
            dockerOptions(root),
            Effect.succeed([]),
          );
          const imgproxy = yield* makeService(imgproxyRecipe.definition, {
            id: "imgproxy",
            config: imgproxyRecipe.creation,
          });
          yield* imgproxy.start;
          yield* imgproxy.ready;
          const imgproxyEndpoint = yield* imgproxyRecipe.endpoint("http");
          const imgproxyResponse = yield* client.execute(
            HttpClientRequest.get(
              `http://${imgproxyEndpoint.host}:${imgproxyEndpoint.port}/health`,
            ),
          );
          expect(imgproxyResponse.status).toBe(200);
          yield* imgproxy.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
});
