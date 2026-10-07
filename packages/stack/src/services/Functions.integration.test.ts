import { NodeHttpClient, NodePath, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { FunctionsBootstrapOwner } from "../functions/FunctionsBootstrap.ts";
import { ContainerError, type ContainerRuntime } from "../runtime/Container.ts";
import { makeStandaloneService } from "../../tests/standalone-service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import * as Functions from "./Functions.ts";
import { makeProcessRecipe } from "./ProcessRecipe.ts";
import { engineTarget, testEngine } from "../../tests/engine-target.ts";
import { httpHost } from "../../tests/helpers/endpoint.ts";
import { testArtifactCacheRoot } from "../../tests/artifact-cache.ts";

const options = (root: string) => ({
  stackId: "catalog-functions",
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

const engineInfo = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(testEngine, ["info"], { stdout: "pipe", stderr: "pipe" }),
    );
    return yield* Stream.mkString(Stream.decodeText(child.all));
  }),
).pipe(Effect.orElseSucceed(() => `${testEngine} info unavailable`));

describe("service catalog", () => {
  it.live(
    "serves a standalone Functions bootstrap over HTTP",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* HttpClient.HttpClient;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-functions-" });
          const stackId = "b".repeat(64);
          const instanceId = "functions-instance";
          // Ownership is by location: a borrowed caller path must live outside the whole stack
          // data root, so the user's functions project lives in its own, separate tree.
          const callerRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "catalog-functions-caller-",
          });
          const functionsRoot = callerRoot + "/user-functions";
          yield* fs.makeDirectory(functionsRoot + "/hello", { recursive: true });
          yield* fs.writeFileString(
            functionsRoot + "/hello/index.ts",
            "Deno.serve(() => Response.json({ custom: Deno.env.get('CUSTOM_ENV'), root: Deno.env.get('SUPABASE_INTERNAL_FUNCTIONS_ROOT'), port: Deno.env.get('EDGE_RUNTIME_PORT'), url: Deno.env.get('SUPABASE_URL'), db: Deno.env.get('SUPABASE_DB_URL'), jwt: Deno.env.get('SUPABASE_INTERNAL_JWT_SECRET'), jwks: Deno.env.get('SUPABASE_JWKS'), anon: Deno.env.get('SUPABASE_ANON_KEY'), service: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), publishable: Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'), secret: Deno.env.get('SUPABASE_SECRET_KEYS') }));",
          );
          const recipe = yield* makeServiceRecipe(
            {
              service: "functions",
              config: {
                functionsRoot,
                databaseUrl: "postgres://functions-db",
                apiUrl: "http://functions-api",
                jwtSecret: "functions-jwt-secret",
                jwks: "functions-jwks",
                anonKey: "active-anon-key",
                serviceRoleKey: "active-service-role-key",
                publishableKey: "active-publishable-key",
                secretKey: "active-secret-key",
                env: {
                  CUSTOM_ENV: "custom-value",
                  SUPABASE_INTERNAL_FUNCTIONS_ROOT: "overridden-root",
                  EDGE_RUNTIME_PORT: "overridden-port",
                  SUPABASE_URL: "overridden-url",
                  SUPABASE_DB_URL: "overridden-db",
                  SUPABASE_INTERNAL_JWT_SECRET: "overridden-jwt",
                  SUPABASE_ANON_KEY: "overridden-anon",
                  SUPABASE_SERVICE_ROLE_KEY: "overridden-service",
                  SUPABASE_JWKS: "overridden-jwks",
                  SUPABASE_INTERNAL_PUBLISHABLE_KEY: "overridden-publishable",
                  SUPABASE_INTERNAL_SECRET_KEY: "overridden-secret",
                },
                verifyJwt: false,
                inspector: true,
              },
            },
            {
              ...dockerOptions(root),
              stackId,
              instanceId,
            },
          );
          const instance = yield* makeStandaloneService(recipe.definition, {
            id: instanceId,
            config: recipe.creation,
          });
          yield* instance.start;
          yield* instance.ready;
          const endpoint = yield* recipe.endpoint("http");
          const response = yield* client.execute(
            HttpClientRequest.get("http://" + httpHost(endpoint) + ":" + endpoint.port + "/hello"),
          );
          expect(response.status).toBe(200);
          expect(yield* response.json).toEqual(
            expect.objectContaining({
              custom: "custom-value",
              port: "9000",
              url: "http://functions-api",
              db: "postgres://functions-db",
              jwks: "functions-jwks",
              anon: "active-anon-key",
              service: "active-service-role-key",
              publishable: '{"default":"active-publishable-key"}',
              secret: '{"default":"active-secret-key"}',
            }),
          );
          const inspector = yield* recipe.endpoint("inspector");
          const inspectorResponse = yield* client.execute(
            HttpClientRequest.get(
              "http://" + httpHost(inspector) + ":" + inspector.port + "/json/version",
            ),
          );
          expect(inspectorResponse.status).toBe(200);
          yield* instance.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );

  it.live("destroy survives a symlink planted where its runtime directory used to be", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "functions-symlink-" });
        const stackId = "c".repeat(64);
        const instanceId = "functions-symlink-instance";
        const callerRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "functions-symlink-caller-",
        });
        const functionsRoot = `${callerRoot}/user-functions`;
        yield* fs.makeDirectory(functionsRoot, { recursive: true });
        yield* fs.writeFileString(`${functionsRoot}/index.ts`, "export default {};");
        const recipe = yield* makeServiceRecipe(
          {
            service: "functions",
            config: { functionsRoot, databaseUrl: "postgres://functions-db" },
          },
          {
            ...options(root),
            stackId,
            instanceId,
          },
        );
        const config = recipe.creation;
        yield* recipe.definition.prepare?.(config) ?? Effect.void;
        const instanceRoot = path.join(root, instanceId);
        const runtimeDir = path.join(instanceRoot, "runtime");
        expect(yield* fs.exists(runtimeDir)).toBe(true);
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "functions-symlink-outside-",
        });
        // removeData reaches for `<runtime>/functions` specifically, not the whole runtime
        // directory; the sentinel sits there so this test proves that previously endangered
        // data survives, not just the symlink target's top level.
        const sentinel = path.join(outside, "functions", "sentinel");
        yield* fs.makeDirectory(path.join(outside, "functions"), { recursive: true });
        yield* fs.writeFileString(sentinel, "do not remove me");
        // The planted attack: the recipe's own runtime directory replaced by a symlink.
        yield* fs.remove(runtimeDir, { recursive: true, force: true });
        yield* fs.symlink(outside, runtimeDir);
        const scope = yield* Scope.make();
        yield* recipe.definition.removeData({ id: instanceId, config, scope });
        yield* Scope.close(scope, Exit.void);
        expect(yield* fs.exists(sentinel)).toBe(true);
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
            // Separate from the stack's own data root: this test's ancestor walk needs
            // functionsRoot nested under `root`, which a borrowed caller path may not be.
            const stackRoot = yield* fs.makeTempDirectoryScoped({
              prefix: "functions-ancestor-stack-",
            });
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
                  verifyJwt: false,
                },
              },
              {
                ...options(stackRoot),
                stackId: "d".repeat(64),
                instanceId: "ancestor",
                cacheRoot: testArtifactCacheRoot,
              },
            );
            const logs = yield* Ref.make("");
            yield* Stream.fromSubscription(yield* recipe.logs).pipe(
              Stream.runForEach(({ bytes }) =>
                Ref.update(logs, (text) => text + new TextDecoder().decode(bytes)),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
            const instance = yield* makeStandaloneService(recipe.definition, {
              id: "ancestor",
              config: recipe.creation,
            });
            yield* instance.start;
            yield* instance.ready.pipe(
              Effect.tapError(() => Ref.get(logs).pipe(Effect.flatMap(Effect.logError))),
            );
            const endpoint = yield* recipe.endpoint("http");
            const response = yield* client.get(
              `http://${httpHost(endpoint)}:${endpoint.port}/hello`,
            );
            expect(response.status, yield* Ref.get(logs)).toBe(200);
            expect(yield* response.text).toBe("shared");
            yield* instance.stop;
          }),
        ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
      { timeout: 120_000 },
    );

  it.live(
    "loads a function's configured deno.jsonc as its Deno config",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* HttpClient.HttpClient;
          const temporaryRoot = `${process.cwd()}/tmp`;
          yield* fs.makeDirectory(temporaryRoot, { recursive: true });
          const root = yield* fs.makeTempDirectoryScoped({
            directory: temporaryRoot,
            prefix: "functions-deno-config-",
          });
          const stackRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "functions-deno-config-stack-",
          });
          const functionsRoot = `${root}/supabase/functions`;
          yield* fs.makeDirectory(`${functionsRoot}/hello`, { recursive: true });
          yield* fs.writeFileString(
            `${functionsRoot}/hello/deno.jsonc`,
            '// Deno config files allow comments; plain import maps do not.\n{"imports":{"message":"./message.ts"}}',
          );
          yield* fs.writeFileString(
            `${functionsRoot}/hello/message.ts`,
            'export const message = "config";',
          );
          yield* fs.writeFileString(
            `${functionsRoot}/hello/index.ts`,
            'import { message } from "message"; Deno.serve(() => new Response(message));',
          );
          const recipe = yield* makeServiceRecipe(
            {
              service: "functions",
              config: {
                functionsRoot,
                verifyJwt: false,
                functions: { hello: { import_map: `${functionsRoot}/hello/deno.jsonc` } },
              },
            },
            {
              ...options(stackRoot),
              stackId: "e".repeat(64),
              instanceId: "deno-config",
              cacheRoot: testArtifactCacheRoot,
            },
          );
          const logs = yield* Ref.make("");
          yield* Stream.fromSubscription(yield* recipe.logs).pipe(
            Stream.runForEach(({ bytes }) =>
              Ref.update(logs, (text) => text + new TextDecoder().decode(bytes)),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          const instance = yield* makeStandaloneService(recipe.definition, {
            id: "deno-config",
            config: recipe.creation,
          });
          yield* instance.start;
          yield* instance.ready.pipe(
            Effect.tapError(() => Ref.get(logs).pipe(Effect.flatMap(Effect.logError))),
          );
          const endpoint = yield* recipe.endpoint("http");

          const response = yield* client.get(`http://${httpHost(endpoint)}:${endpoint.port}/hello`);

          expect(response.status, yield* Ref.get(logs)).toBe(200);
          expect(yield* response.text).toBe("config");
          yield* instance.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );

  it.live(
    "warns when a configured Deno config is not the one Edge Runtime discovers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* HttpClient.HttpClient;
          const temporaryRoot = `${process.cwd()}/tmp`;
          yield* fs.makeDirectory(temporaryRoot, { recursive: true });
          const root = yield* fs.makeTempDirectoryScoped({
            directory: temporaryRoot,
            prefix: "functions-plain-deno-config-",
          });
          const stackRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "functions-plain-deno-config-stack-",
          });
          const functionsRoot = `${root}/supabase/functions`;
          yield* fs.makeDirectory(`${functionsRoot}/hello`, { recursive: true });
          yield* fs.makeDirectory(`${functionsRoot}/_shared`, { recursive: true });
          yield* fs.writeFileString(
            `${functionsRoot}/_shared/deno.jsonc`,
            '{"imports":{"message":"./message.ts"}}',
          );
          yield* fs.writeFileString(
            `${functionsRoot}/_shared/message.ts`,
            'export const message = "shared";',
          );
          yield* fs.writeFileString(
            `${functionsRoot}/hello/index.ts`,
            'import { message } from "message"; Deno.serve(() => new Response(message));',
          );
          const recipe = yield* makeServiceRecipe(
            {
              service: "functions",
              config: {
                functionsRoot,
                verifyJwt: false,
                functions: { hello: { import_map: `${functionsRoot}/_shared/deno.jsonc` } },
              },
            },
            {
              ...options(stackRoot),
              stackId: "f".repeat(64),
              instanceId: "plain-deno-config",
              cacheRoot: testArtifactCacheRoot,
            },
          );
          const logs = yield* Ref.make("");
          const warned = yield* Deferred.make<void>();
          yield* Stream.fromSubscription(yield* recipe.logs).pipe(
            Stream.runForEach(({ bytes }) =>
              Ref.updateAndGet(logs, (text) => text + new TextDecoder().decode(bytes)).pipe(
                Effect.flatMap((text) =>
                  text.includes("is not the nearest Deno config")
                    ? Deferred.succeed(warned, undefined)
                    : Effect.void,
                ),
              ),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          const instance = yield* makeStandaloneService(recipe.definition, {
            id: "plain-deno-config",
            config: recipe.creation,
          });
          yield* instance.start;
          yield* instance.ready.pipe(
            Effect.tapError(() => Ref.get(logs).pipe(Effect.flatMap(Effect.logError))),
          );
          const endpoint = yield* recipe.endpoint("http");

          const response = yield* client.get(`http://${httpHost(endpoint)}:${endpoint.port}/hello`);
          yield* Deferred.await(warned).pipe(
            Effect.timeout("30 seconds"),
            Effect.tapError(() => Ref.get(logs).pipe(Effect.flatMap(Effect.logError))),
          );

          expect(response.status).toBe(200);
          expect(yield* Ref.get(logs)).toContain(
            `hello: ${yield* fs.realPath(functionsRoot)}/_shared/deno.jsonc is not the nearest Deno config`,
          );
          yield* instance.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
});

for (const runtime of ["native", testEngine] as const) {
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
          const stackRoot = yield* fs.makeTempDirectoryScoped({
            directory: temporaryRoot,
            prefix: "functions-configured-stack-",
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
              ...options(stackRoot),
              stackId: "c".repeat(64),
              instanceId: "configured",
              runtime,
              ...(runtime !== "native" ? { engineTarget } : {}),
              cacheRoot: testArtifactCacheRoot,
            },
          );
          const logs = yield* Ref.make("");
          yield* Stream.fromSubscription(yield* recipe.logs).pipe(
            Stream.runForEach(({ bytes }) =>
              Ref.update(logs, (text) => text + new TextDecoder().decode(bytes)),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          const instance = yield* makeStandaloneService(recipe.definition, {
            id: "configured",
            config: recipe.creation,
          });
          yield* Effect.gen(function* () {
            yield* instance.start;
            yield* instance.ready.pipe(
              Effect.catchCause((cause) =>
                Ref.get(logs).pipe(
                  Effect.flatMap((text) =>
                    Effect.die(`${Cause.pretty(cause)}\nStartup logs:\n${text}`),
                  ),
                ),
              ),
            );
            const endpoint = yield* recipe.endpoint("http");
            const base = `http://${httpHost(endpoint)}:${endpoint.port}`;
            const response = yield* client.execute(HttpClientRequest.get(`${base}/hello`));
            const responseText = yield* response.text;
            expect(response.status, responseText).toBe(200);
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
          }).pipe(
            Effect.tapCause(() =>
              Effect.gen(function* () {
                yield* Effect.logError(`Functions ${runtime} logs:\n${yield* Ref.get(logs)}`);
                if (runtime !== "native")
                  yield* Effect.logError(`${testEngine} info:\n${yield* engineInfo}`);
              }),
            ),
          );
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
}

it.effect("passes POSIX project paths to a docker Functions container from a Windows host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const launched = yield* Ref.make<Parameters<ContainerRuntime["launch"]>[0] | undefined>(
        undefined,
      );
      const container: ContainerRuntime = {
        prepare: () => Effect.void,
        prepareImage: (image) => Effect.succeed(image),
        launchCommand: () => Effect.die("Functions has no startup commands"),
        launch: (spec) =>
          Ref.set(launched, spec).pipe(
            Effect.andThen(
              Effect.fail(new ContainerError({ operation: "start", message: "captured" })),
            ),
          ),
      };
      const filesRoot = "C:\\Users\\dev\\project";
      const creation: Functions.Creation = {
        service: "functions",
        config: {
          functionsRoot: `${filesRoot}\\supabase\\functions`,
          filesRoot,
          functions: {
            hello: {
              entrypoint: `${filesRoot}\\source\\main.ts`,
              import_map: `${filesRoot}\\supabase\\import_map.json`,
              static_files: [`${filesRoot}\\source\\*.txt`],
            },
          },
        },
      };
      // A real bootstrap owner would join the Win32 stack root below with real fs calls, writing a
      // garbled path on this POSIX test host; a fake owner keeps the test to what it exercises
      // here, the Windows caller-path translation in `env`/`args`.
      const fakeBootstrap: FunctionsBootstrapOwner = {
        root: "/fake-bootstrap-root",
        write: () => Effect.succeed("/fake-bootstrap-root/generation-fake/index.ts"),
      };
      const deps = {
        borrowCallerPath: () => Effect.die("borrowCallerPath not exercised in this test"),
        fs: yield* FileSystem.FileSystem,
        path: yield* Path.Path.pipe(Effect.provide(NodePath.layerWin32)),
        crypto: yield* Crypto.Crypto,
        client: yield* HttpClient.HttpClient,
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        container,
      };
      const recipe = yield* makeProcessRecipe(
        {
          stackId: "e".repeat(64),
          instanceId: "windows",
          root: "C:\\Users\\dev\\stack",
          cacheRoot: "C:\\Users\\dev\\cache",
          runtime: "docker",
        },
        deps,
        Functions.makeSpec(fakeBootstrap, deps.path, deps.fs),
      );
      const scope = yield* Scope.make();
      yield* recipe.definition
        .launch({ id: "windows", config: creation, scope, launchId: 1 })
        .pipe(Effect.flip, Effect.ensuring(Scope.close(scope, Exit.void)));

      const spec = yield* Ref.get(launched);
      expect(spec?.env.SUPABASE_INTERNAL_FUNCTIONS_ROOT).toBe(
        "/__supabase_project/supabase/functions",
      );
      expect(spec?.env.SUPABASE_INTERNAL_FUNCTIONS_FILES_ROOT).toBe("/__supabase_project");
      expect(spec?.args).toContain("--main-service=/__supabase_bootstrap/generation-fake");
      const config = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Record(
            Schema.String,
            Schema.Struct({
              entrypoint: Schema.optionalKey(Schema.String),
              import_map: Schema.optionalKey(Schema.String),
              static_files: Schema.optionalKey(Schema.Array(Schema.String)),
            }),
          ),
        ),
      )(spec?.env.SUPABASE_INTERNAL_FUNCTIONS_CONFIG);
      expect(config.hello).toEqual({
        entrypoint: "/__supabase_project/source/main.ts",
        import_map: "/__supabase_project/supabase/import_map.json",
        static_files: ["/__supabase_project/source/*.txt"],
      });
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
