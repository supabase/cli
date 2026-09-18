import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeService } from "../Service.ts";
import { bundleServeMainTemplate } from "../../tests/serve-main-bundler.ts";
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
  it.live("serves a standalone Functions bootstrap over HTTP", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const client = yield* HttpClient.HttpClient;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-functions-" });
        const stackId = "b".repeat(64);
        const instanceId = "functions-instance";
        const functionsRoot = root + "/user-functions";
        yield* fs.makeDirectory(functionsRoot + "/hello", { recursive: true });
        yield* fs.writeFileString(
          functionsRoot + "/hello/index.ts",
          "Deno.serve(() => new Response('catalog-functions'));",
        );
        const bootstrap = yield* bundleServeMainTemplate;
        const recipe = yield* makeServiceRecipe(
          {
            service: "functions",
            config: { functionsRoot, bootstrap, verifyJwt: false, inspector: true },
          },
          { ...dockerOptions(root), stackId, instanceId },
        );
        const instance = yield* makeService(recipe.definition, {
          id: instanceId,
          config: recipe.creation,
        });
        yield* instance.start;
        yield* instance.ready;
        const endpoint = yield* recipe.endpoint("http");
        const response = yield* client.execute(
          HttpClientRequest.get("http://" + endpoint.host + ":" + endpoint.port + "/hello"),
        );
        expect(response.status).toBe(200);
        expect(yield* response.text).toContain("catalog-functions");
        const inspector = yield* recipe.endpoint("inspector");
        const inspectorResponse = yield* client.execute(
          HttpClientRequest.get(
            "http://" + inspector.host + ":" + inspector.port + "/json/version",
          ),
        );
        expect(inspectorResponse.status).toBe(200);
        yield* instance.stop;
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );
});
