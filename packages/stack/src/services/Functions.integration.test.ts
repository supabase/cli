import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Ref, Schema, Stream } from "effect";
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

  const ancestors = [
    {
      name: "a package.json with an unreadable sibling",
      setup: (fs: FileSystem.FileSystem, root: string) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(`${root}/package.json`, '{"name":"home","private":true}');
          yield* fs.makeDirectory(`${root}/unreadable`);
          yield* fs.chmod(`${root}/unreadable`, 0o000);
          yield* Effect.addFinalizer(() =>
            fs.chmod(`${root}/unreadable`, 0o755).pipe(Effect.ignore),
          );
        }),
    },
    {
      name: "a Deno workspace that includes the project functions",
      setup: (fs: FileSystem.FileSystem, root: string) =>
        fs.writeFileString(`${root}/deno.json`, '{"workspace":["./project/supabase/functions"]}'),
    },
  ];
  for (const ancestor of ancestors)
    it.live(
      `boots below ${ancestor.name} and keeps shared functions deno.json imports`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const client = yield* HttpClient.HttpClient;
            const temporaryRoot = `${process.cwd()}/tmp`;
            yield* fs.makeDirectory(temporaryRoot, { recursive: true });
            const root = yield* fs.makeTempDirectoryScoped({
              directory: temporaryRoot,
              prefix: "functions-ancestor-",
            });
            yield* ancestor.setup(fs, root);
            const functionsRoot = `${root}/project/supabase/functions`;
            yield* fs.makeDirectory(`${functionsRoot}/hello`, { recursive: true });
            yield* fs.makeDirectory(`${functionsRoot}/_shared`, { recursive: true });
            yield* fs.writeFileString(
              `${functionsRoot}/deno.json`,
              '{"imports":{"shared-message":"./_shared/message.ts"}}',
            );
            yield* fs.writeFileString(
              `${functionsRoot}/_shared/message.ts`,
              'export const message = "shared";',
            );
            yield* fs.writeFileString(
              `${functionsRoot}/hello/index.ts`,
              'import { message } from "shared-message"; Deno.serve(() => new Response(message));',
            );
            const recipe = yield* makeServiceRecipe(
              {
                service: "functions",
                config: {
                  functionsRoot,
                  bootstrap: yield* bundleServeMainTemplate,
                  verifyJwt: false,
                },
              },
              {
                ...options(root),
                stackId: "d".repeat(64),
                instanceId: "ancestor",
                cacheRoot: "/tmp/supabase-stack-artifacts",
              },
            );
            const logs = yield* Ref.make("");
            yield* recipe.logs.pipe(
              Stream.runForEach(({ bytes }) =>
                Ref.update(logs, (text) => text + new TextDecoder().decode(bytes)),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
            const instance = yield* makeService(recipe.definition, {
              id: "ancestor",
              config: recipe.creation,
            });
            yield* instance.start;
            yield* instance.ready.pipe(
              Effect.tapError(() => Ref.get(logs).pipe(Effect.flatMap(Effect.logError))),
            );
            const endpoint = yield* recipe.endpoint("http");
            const response = yield* client.get(`http://${endpoint.host}:${endpoint.port}/hello`);
            expect(response.status, yield* Ref.get(logs)).toBe(200);
            expect(yield* response.text).toBe("shared");
            yield* instance.stop;
          }),
        ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
      { timeout: 120_000 },
    );
});

for (const runtime of ["native", "docker"] as const) {
  it.live(
    `serves configured function files, secrets and JWT policies in ${runtime}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* HttpClient.HttpClient;
          // Edge Runtime's Linux sandbox does not expose host paths under /tmp.
          const temporaryRoot = `${process.cwd()}/tmp`;
          yield* fs.makeDirectory(temporaryRoot, { recursive: true });
          const root = yield* fs.makeTempDirectoryScoped({
            directory: temporaryRoot,
            prefix: "functions-configured-",
          });
          const filesRoot = `${root}/project`;
          const functionsRoot = `${filesRoot}/supabase/functions`;
          yield* fs.makeDirectory(`${functionsRoot}/locked`, { recursive: true });
          yield* fs.makeDirectory(`${filesRoot}/source`, { recursive: true });
          yield* fs.writeFileString(
            `${filesRoot}/source/main.ts`,
            `import {message} from "message"; Deno.serve(async () => Response.json({message, local: Deno.env.get("LOCAL"), shared: Deno.env.get("SHARED"), asset: await Deno.readTextFile(new URL("./asset.txt", import.meta.url))}));`,
          );
          yield* fs.writeFileString(
            `${filesRoot}/source/message.ts`,
            'export const message = "custom entrypoint";',
          );
          yield* fs.writeFileString(`${filesRoot}/source/asset.txt`, "static content");
          yield* fs.writeFileString(
            `${filesRoot}/supabase/import_map.json`,
            '{"imports":{"message":"../source/message.ts"}}',
          );
          yield* fs.writeFileString(
            `${functionsRoot}/locked/index.ts`,
            'Deno.serve(() => new Response("locked"));',
          );
          const recipe = yield* makeServiceRecipe(
            {
              service: "functions",
              config: {
                functionsRoot,
                filesRoot,
                bootstrap: yield* bundleServeMainTemplate,
                jwtSecret: "test-function-jwt-with-at-least-32-characters",
                verifyJwt: true,
                env: {
                  SHARED: "shared",
                  LOCAL: "global",
                  SUPABASE_INTERNAL_DEBUG: "true",
                },
                functions: {
                  hello: {
                    verifyJWT: false,
                    entrypoint: `${filesRoot}/source/main.ts`,
                    import_map: `${filesRoot}/supabase/import_map.json`,
                    static_files: [`${filesRoot}/source/*.txt`],
                    env: { LOCAL: "function" },
                  },
                  disabled: { enabled: false, entrypoint: `${filesRoot}/source/main.ts` },
                },
              },
            },
            {
              ...options(root),
              stackId: "c".repeat(64),
              instanceId: "configured",
              runtime,
              cacheRoot: "/tmp/supabase-stack-artifacts",
            },
          );
          const logs = yield* Ref.make("");
          yield* recipe.logs.pipe(
            Stream.runForEach(({ bytes }) =>
              Ref.update(logs, (text) => text + new TextDecoder().decode(bytes)),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          const instance = yield* makeService(recipe.definition, {
            id: "configured",
            config: recipe.creation,
          });
          yield* instance.start;
          yield* instance.ready;
          const endpoint = yield* recipe.endpoint("http");
          const base = `http://${endpoint.host}:${endpoint.port}`;
          const response = yield* client.execute(HttpClientRequest.get(`${base}/hello`));
          const responseText = yield* response.text;
          expect(response.status, `${yield* Ref.get(logs)}\n${responseText}`).toBe(200);
          const body = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                message: Schema.String,
                local: Schema.String,
                shared: Schema.String,
                asset: Schema.String,
              }),
            ),
          )(responseText);
          expect(body).toEqual({
            message: "custom entrypoint",
            local: "function",
            shared: "shared",
            asset: "static content",
          });
          expect((yield* client.get(`${base}/disabled`)).status).toBe(404);
          expect((yield* client.get(`${base}/locked`)).status).toBe(401);
          yield* instance.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
}
