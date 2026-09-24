import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { tmpdir } from "node:os";
import { Effect, FileSystem, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeService } from "../Service.ts";
import { makeServiceRecipe } from "./Catalog.ts";

const options = (root: string, runtime: "docker" | "native") => ({
  stackId: "catalog-test",
  instanceId: "vector",
  root,
  cacheRoot: `${tmpdir()}/supabase-stack-artifacts`,
  runtime,
});

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
});
