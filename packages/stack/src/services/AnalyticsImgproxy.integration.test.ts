import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { makeService } from "../Service.ts";
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

describe("service catalog", () => {
  it.live(
    "serves Analytics and Imgproxy with their real endpoints",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* HttpClient.HttpClient;
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
            Effect.succeed([]),
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
          yield* analytics.stop;
          yield* database.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
});
