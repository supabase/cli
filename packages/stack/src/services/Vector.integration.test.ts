import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { tmpdir } from "node:os";
import { Effect, FileSystem, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeStandaloneService } from "../../tests/standalone-service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { noPublicPortReservations } from "../../tests/port-reservations.ts";
import { dockerEngineTarget } from "../../tests/engine-target.ts";
import { httpHost } from "../../tests/helpers/endpoint.ts";

const options = (root: string, runtime: "docker" | "native") => ({
  stackId: "catalog-test",
  instanceId: "vector",
  root,
  cacheRoot: `${tmpdir()}/supabase-stack-artifacts`,
  runtime,
  ...(runtime === "docker" ? { engineTarget: dockerEngineTarget } : {}),
  isPubliclyReserved: noPublicPortReservations,
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
            const vector = yield* makeStandaloneService(recipe.definition, {
              id: "vector",
              config: recipe.creation,
            });
            yield* vector.start;
            yield* vector.ready;
            const endpoint = yield* recipe.endpoint("http");
            const response = yield* client.execute(
              HttpClientRequest.get(`http://${httpHost(endpoint)}:${endpoint.port}/health`),
            );
            expect(response.status).toBe(200);
            yield* fs.makeDirectory(`${root}/vector/runtime/vector/.vector-api.yaml-interrupted`);
            yield* vector.destroy;
            expect(yield* fs.exists(`${root}/vector`)).toBe(false);
          }),
        ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
      { timeout: 120_000 },
    );
  }

  it.live(
    "leaves a caller pipeline stored outside the owned instance root on destroy",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-vector-caller-" });
          // Ownership is by location: a borrowed caller config must live outside the stack's
          // entire data root, not merely outside this instance's own instanceRoot.
          const external = yield* fs.makeTempDirectoryScoped({
            prefix: "catalog-vector-caller-external-",
          });
          const pipeline = `${external}/pipeline.yaml`;
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
          const vector = yield* makeStandaloneService(recipe.definition, {
            id: "vector",
            config: recipe.creation,
          });
          yield* vector.start;
          yield* vector.ready;
          yield* vector.destroy;
          expect(yield* fs.exists(pipeline)).toBe(true);
          expect(yield* fs.exists(`${root}/vector`)).toBe(false);
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );

  it.live(
    "keeps the published config files' identity across a restart with unchanged content",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-vector-restart-" });
          const configRoot = `${root}/vector/runtime/vector`;
          const recipe = yield* makeServiceRecipe(
            {
              service: "vector",
              config: { analyticsUrl: "http://analytics" },
              endpoints: { http: { port: "auto" } },
            },
            options(root, "docker"),
          );
          const vector = yield* makeStandaloneService(recipe.definition, {
            id: "vector",
            config: recipe.creation,
          });
          const inodesByFile = Effect.gen(function* () {
            const [generation, ...rest] = (yield* fs.readDirectory(configRoot)).filter((entry) =>
              entry.startsWith("generation-"),
            );
            expect(rest).toEqual([]);
            const stats = yield* Effect.forEach(
              ["vector-api.yaml", "vector-pipeline.yaml"],
              (name) => fs.stat(`${configRoot}/${generation}/${name}`),
            );
            return { generation, inodes: stats.map((stat) => stat.ino) };
          });

          yield* vector.start;
          yield* vector.ready;
          const before = yield* inodesByFile;

          // A docker Vector launch always binds `0.0.0.0:9001` inside the container regardless of
          // the published host port, so a restart with the same config republishes byte-identical
          // content: the generation name, and every file's identity, must not change.
          yield* vector.restart();
          yield* vector.ready;
          const after = yield* inodesByFile;

          expect(after.generation).toBe(before.generation);
          expect(after.inodes).toEqual(before.inodes);
          yield* vector.destroy;
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
            const vector = yield* makeStandaloneService(recipe.definition, {
              id: "vector",
              config: recipe.creation,
            });
            return yield* vector.start.pipe(Effect.flip);
          });
        for (const configPath of [owned, `${root}/alias.yaml`])
          expect((yield* start(configPath)).message).toContain(
            "resolves inside the owned data root",
          );
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );
});
