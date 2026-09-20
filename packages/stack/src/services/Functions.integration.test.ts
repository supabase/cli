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
          "Deno.serve(() => Response.json({ custom: Deno.env.get('CUSTOM_ENV'), root: Deno.env.get('SUPABASE_INTERNAL_FUNCTIONS_ROOT'), port: Deno.env.get('EDGE_RUNTIME_PORT'), url: Deno.env.get('SUPABASE_URL'), db: Deno.env.get('SUPABASE_DB_URL'), jwt: Deno.env.get('SUPABASE_INTERNAL_JWT_SECRET'), anon: Deno.env.get('SUPABASE_ANON_KEY'), service: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') }));",
        );
        const bootstrap = yield* bundleServeMainTemplate;
        const recipe = yield* makeServiceRecipe(
          {
            service: "functions",
            config: {
              functionsRoot,
              bootstrap,
              databaseUrl: "postgres://functions-db",
              apiUrl: "http://functions-api",
              jwtSecret: "functions-jwt-secret",
              env: {
                CUSTOM_ENV: "custom-value",
                SUPABASE_INTERNAL_FUNCTIONS_ROOT: "overridden-root",
                EDGE_RUNTIME_PORT: "overridden-port",
                SUPABASE_URL: "overridden-url",
                SUPABASE_DB_URL: "overridden-db",
                SUPABASE_INTERNAL_JWT_SECRET: "overridden-jwt",
                SUPABASE_ANON_KEY: "overridden-anon",
                SUPABASE_SERVICE_ROLE_KEY: "overridden-service",
              },
              verifyJwt: false,
              inspector: true,
            },
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
        expect(yield* response.json).toEqual(
          expect.objectContaining({
            custom: "custom-value",
            port: "9000",
            url: "http://functions-api",
            db: "postgres://functions-db",
            anon: expect.stringMatching(/^ey/u),
            service: expect.stringMatching(/^ey/u),
          }),
        );
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
