import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeService } from "../Service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { makeDockerHttpRelay, makeDockerTcpRelay } from "../../tests/docker-relay.ts";
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
    "serves Analytics, Vector, and Imgproxy with their real endpoints",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* HttpClient.HttpClient;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-optional-data-" });
          yield* Effect.addFinalizer(() => cleanupDockerRoot(root));
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
          const database = yield* makeService(databaseRecipe.definition, {
            id: "database",
            config: databaseRecipe.creation,
          });
          yield* database.start;
          yield* database.ready;
          const databaseRelay = yield* makeDockerTcpRelay(databaseRecipe.endpoint("sql"));
          const databaseUrl = `postgresql://supabase_admin:postgres@${databaseRelay.host}:${databaseRelay.port}/postgres`;

          const analyticsRecipe = yield* makeServiceRecipe(
            {
              service: "analytics",
              config: { databaseUrl, backend: "postgres", apiKey: "catalog-analytics" },
            },
            dockerOptions(root),
          );
          const analytics = yield* makeService(analyticsRecipe.definition, {
            id: "analytics",
            config: analyticsRecipe.creation,
          });
          yield* analytics.start;
          yield* analytics.ready;
          const analyticsEndpoint = yield* analyticsRecipe.endpoint("http");
          const analyticsRelay = yield* makeDockerHttpRelay(analyticsRecipe.endpoint("http"));
          const analyticsResponse = yield* client.execute(
            HttpClientRequest.get(
              `http://${analyticsEndpoint.host}:${analyticsEndpoint.port}/health`,
            ),
          );
          expect(analyticsResponse.status).toBe(200);

          const vectorRecipe = yield* makeServiceRecipe(
            {
              service: "vector",
              config: {
                analyticsUrl: `http://${analyticsRelay.host}:${analyticsRelay.port}`,
                apiKey: "catalog-analytics",
                configPath: `${root}/vector.yaml`,
              },
            },
            dockerOptions(root),
          );
          yield* fs.writeFileString(
            `${root}/vector.yaml`,
            "sources:\n  dummy:\n    type: demo_logs\n    format: syslog\n    interval: 60\n" +
              "sinks:\n  print:\n    type: console\n    inputs: [dummy]\n    encoding:\n      codec: json\n" +
              "api:\n  enabled: true\n  address: 0.0.0.0:9001\n",
          );
          const vector = yield* makeService(vectorRecipe.definition, {
            id: "vector",
            config: vectorRecipe.creation,
          });
          yield* vector.start;
          yield* vector.ready;
          const vectorEndpoint = yield* vectorRecipe.endpoint("http");
          const vectorResponse = yield* client.execute(
            HttpClientRequest.get(`http://${vectorEndpoint.host}:${vectorEndpoint.port}/health`),
          );
          expect(vectorResponse.status).toBe(200);

          const imageRoot = `${root}/images`;
          yield* fs.makeDirectory(imageRoot, { recursive: true });
          const imgproxyRecipe = yield* makeServiceRecipe(
            { service: "imgproxy", config: { filePath: imageRoot } },
            dockerOptions(root),
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
          yield* vector.stop;
          yield* analytics.stop;
          yield* database.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
});
