import { createContext, SourceTextModule } from "node:vm";
import { Data, Deferred, Effect, Exit, FileSystem, Path, Schema, Stream } from "effect";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { bundleServeMainTemplate } from "../../tests/serve-main-bundler.ts";

type ServeOptions = {
  readonly handler: (request: Request) => Promise<Response>;
  readonly onListen: () => void;
};

class MissingFixture extends Data.TaggedError("MissingFixture") {}

describe("stack-owned functions bootstrap", () => {
  it.live("produces an executable offline service with the expected runtime contract", () => {
    const controller = new AbortController();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem | Path.Path>());
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-bootstrap-" });
      yield* fs.makeDirectory(path.join(root, "hello"));
      yield* fs.writeFileString(path.join(root, "hello", "index.ts"), "export default 1");
      const secret = "bootstrap-test-secret";
      const envRecord: Record<string, string> = {
        SUPABASE_INTERNAL_FUNCTIONS_ROOT: root,
        SUPABASE_INTERNAL_JWT_SECRET: secret,
        KEEP: "yes",
      };
      let createOptions: Record<string, unknown> | undefined;
      let received: Request | undefined;
      let serveOptions: ServeOptions | undefined;
      type TestWorker = { fetch(request: Request): Promise<Response> };
      let fetchCalls = 0;
      const worker: TestWorker = {
        fetch: (request: Request) => {
          fetchCalls += 1;
          received = request;
          return Promise.resolve(new Response(request.body));
        },
      };
      let pendingCreation: Promise<TestWorker> | undefined;
      const workerReady = yield* Deferred.make<TestWorker>();
      const createStarted = yield* Deferred.make<void>();
      const bundled = yield* bundleServeMainTemplate;
      const sandbox = {
        Deno: {
          env: {
            get: (name: string) => envRecord[name],
            toObject: () => envRecord,
          },
          lstat: (filename: string) =>
            run(
              fs.stat(filename).pipe(
                Effect.map((info) => ({
                  isDirectory: info.type === "Directory",
                  isFile: info.type === "File",
                  isSymlink: false,
                })),
              ),
            ),
          realPath: (filename: string) => run(fs.realPath(filename)),
          errors: {},
          serve: (options: ServeOptions) => {
            serveOptions = options;
          },
        },
        EdgeRuntime: {
          applySupabaseTag: () => undefined,
          userWorkers: {
            create: (options: Record<string, unknown>) => {
              createOptions = options;
              const creation = pendingCreation;
              return creation === undefined
                ? Promise.resolve(worker)
                : run(Deferred.succeed(createStarted, undefined)).then(() => creation);
            },
          },
        },
        AbortController,
        Request,
        Response,
        URL,
        console,
        crypto,
        CryptoKey,
        Uint8Array,
        ArrayBuffer,
        atob,
        btoa,
        setTimeout,
        clearTimeout,
        TextEncoder,
        TextDecoder,
        structuredClone,
      };

      const module = new SourceTextModule(bundled, {
        context: createContext(sandbox),
        identifier: "serve.main.bundle.js",
      });
      yield* Effect.tryPromise(() =>
        module.link(() => {
          throw new Error("Bundled service unexpectedly imported another module");
        }),
      );
      yield* Effect.tryPromise(() => module.evaluate());

      if (serveOptions === undefined)
        return yield* Effect.die("Bundled service did not register a server");
      const registered = serveOptions;

      const health = yield* Effect.tryPromise(() =>
        registered.handler(new Request("http://127.0.0.1/_internal/health")),
      );
      const body = yield* Effect.tryPromise(() => health.json());
      expect({ status: health.status, body }).toEqual({
        status: 200,
        body: { message: "ok" },
      });
      const token = yield* Effect.tryPromise(() =>
        new SignJWT({ sub: "bootstrap-test" })
          .setProtectedHeader({ alg: "HS256" })
          .sign(new TextEncoder().encode(secret)),
      );
      const invoke = (jwt: string) =>
        Effect.tryPromise(() =>
          registered.handler(
            new Request("http://127.0.0.1/hello", {
              headers: { Authorization: `Bearer ${jwt}` },
            }),
          ),
        );
      const valid = yield* Effect.tryPromise(() =>
        registered.handler(
          new Request("http://127.0.0.1/hello", {
            method: "POST",
            body: "hello",
            headers: {
              Authorization: `Bearer ${token}`,
              "x-forwarded-host": "forwarded.example",
            },
          }),
        ),
      );
      expect(valid.status).toBe(200);
      expect(yield* Effect.tryPromise(() => valid.text())).toBe("hello");
      expect(received?.url).toBe("http://forwarded.example/hello");
      expect(createOptions).toMatchObject({
        memoryLimitMb: 256,
        noModuleCache: true,
        noNpm: true,
        forceCreate: true,
        staticPatterns: [],
      });
      expect(createOptions?.envVars).toEqual(
        expect.arrayContaining([
          ["KEEP", "yes"],
          ["SUPABASE_FUNCTION_SLUG", "hello"],
        ]),
      );
      const wrongToken = yield* Effect.tryPromise(() =>
        new SignJWT({ sub: "bootstrap-test" })
          .setProtectedHeader({ alg: "HS256" })
          .sign(new TextEncoder().encode("wrong-secret")),
      );
      const invalidSignature = yield* invoke(wrongToken);
      expect(invalidSignature.status).toBe(401);
      expect(yield* Effect.tryPromise(() => invalidSignature.json())).toMatchObject({
        code: "UNAUTHORIZED_JWT",
      });
      const malformed = yield* invoke("invalid");
      expect(malformed.status).toBe(401);
      expect(yield* Effect.tryPromise(() => malformed.json())).toMatchObject({
        code: "UNAUTHORIZED_INVALID_JWT_FORMAT",
      });
      pendingCreation = run(Deferred.await(workerReady));
      const previousFetchCalls = fetchCalls;
      const pending = registered.handler(
        new Request("http://127.0.0.1/hello", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        }),
      );
      yield* Deferred.await(createStarted);
      controller.abort();
      const aborted = yield* Effect.tryPromise(() => pending);
      expect(aborted.status).toBe(499);
      yield* Deferred.succeed(workerReady, worker);
      yield* Deferred.await(workerReady);
      expect(fetchCalls).toBe(previousFetchCalls);
      const metricExit = yield* Effect.exit(
        Effect.tryPromise(() =>
          registered.handler(new Request("http://127.0.0.1/_internal/metric")),
        ),
      );
      expect(Exit.isFailure(metricExit)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  });

  it.live("starts with malformed optional functions config", () =>
    Effect.gen(function* () {
      const bundled = yield* bundleServeMainTemplate;
      const envRecord: Record<string, string> = { SUPABASE_INTERNAL_FUNCTIONS_CONFIG: "{" };
      let serveOptions: ServeOptions | undefined;
      const sandbox = {
        Deno: {
          env: {
            get: (name: string) => envRecord[name],
            toObject: () => envRecord,
          },
          errors: {},
          serve: (options: ServeOptions) => {
            serveOptions = options;
          },
        },
        EdgeRuntime: {
          applySupabaseTag: () => undefined,
          userWorkers: {
            create: () => Promise.resolve({ fetch: () => Promise.resolve(new Response("ok")) }),
          },
        },
        AbortController,
        Request,
        Response,
        URL,
        console,
        crypto,
        CryptoKey,
        Uint8Array,
        ArrayBuffer,
        atob,
        btoa,
        setTimeout,
        clearTimeout,
        TextEncoder,
        TextDecoder,
        structuredClone,
      };
      const module = new SourceTextModule(bundled, {
        context: createContext(sandbox),
        identifier: "serve.main.malformed-config.bundle.js",
      });
      yield* Effect.tryPromise(() =>
        module.link(() => {
          throw new Error("Bundled service unexpectedly imported another module");
        }),
      );
      yield* Effect.tryPromise(() => module.evaluate());
      if (serveOptions === undefined)
        return yield* Effect.die("Bundled service did not register a server");
      const registered = serveOptions;
      const response = yield* Effect.tryPromise(() =>
        registered.handler(new Request("http://127.0.0.1/_internal/health")),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({ message: "ok" });
      const missing = yield* Effect.tryPromise(() =>
        registered.handler(new Request("http://127.0.0.1/missing")),
      );
      expect(missing.status).toBe(404);
      expect(yield* Effect.tryPromise(() => missing.text())).toBe("Function not found");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("falls back to remote JWKs for malformed local key entries", () =>
    Effect.gen(function* () {
      const run = Effect.runPromiseWith(yield* Effect.context());
      const { publicKey, privateKey } = yield* Effect.tryPromise(() => generateKeyPair("ES256"));
      const publicJwk = yield* Effect.tryPromise(() => exportJWK(publicKey));
      const remoteJwks = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        keys: [{ ...publicJwk, kid: "test-key" }],
      });
      const token = yield* Effect.tryPromise(() =>
        new SignJWT({ sub: "bootstrap-test" })
          .setProtectedHeader({ alg: "ES256", kid: "test-key" })
          .sign(privateKey),
      );
      const bundled = yield* bundleServeMainTemplate;
      const envRecord: Record<string, string> = {
        SUPABASE_INTERNAL_FUNCTIONS_ROOT: "/functions",
        SUPABASE_INTERNAL_JWT_SECRET: "secret",
        SUPABASE_INTERNAL_FUNCTIONS_CONFIG: '{"hello":{"verifyJWT":true}}',
        SUPABASE_JWKS: '{"keys":[null]}',
      };
      let serveOptions: ServeOptions | undefined;
      let fetchCalls = 0;
      const sandbox = {
        Deno: {
          env: {
            get: (name: string) => envRecord[name],
            toObject: () => envRecord,
          },
          errors: {},
          lstat: (path: string) => {
            const isDirectory = path === "/functions" || path === "/functions/hello";
            const isFile = path === "/functions/hello/index.ts";
            return run(
              isDirectory || isFile
                ? Effect.succeed({ isDirectory, isFile, isSymlink: false })
                : Effect.fail(new MissingFixture()),
            );
          },
          realPath: (path: string) => run(Effect.succeed(path)),
          readDir: () => Stream.toAsyncIterable(Stream.empty),
          makeTempDirSync: () => "/tmp/worker",
          version: { deno: "test" },
          serve: (options: ServeOptions) => {
            serveOptions = options;
          },
        },
        EdgeRuntime: {
          applySupabaseTag: () => undefined,
          userWorkers: {
            create: () => Promise.resolve({ fetch: () => Promise.resolve(new Response("ok")) }),
          },
        },
        AbortController,
        AbortSignal,
        Headers,
        Request,
        Response,
        URL,
        console,
        crypto,
        CryptoKey,
        Uint8Array,
        ArrayBuffer,
        atob,
        btoa,
        fetch: () =>
          run(
            Effect.sync(() => {
              fetchCalls += 1;
              return new Response(remoteJwks, {
                headers: { "content-type": "application/json" },
              });
            }),
          ),
        setTimeout,
        clearTimeout,
        TextEncoder,
        TextDecoder,
        structuredClone,
      };
      const module = new SourceTextModule(bundled, {
        context: createContext(sandbox),
        identifier: "serve.main.malformed-jwks.bundle.js",
      });
      yield* Effect.tryPromise(() =>
        module.link(() => {
          throw new Error("Bundled service unexpectedly imported another module");
        }),
      );
      yield* Effect.tryPromise(() => module.evaluate());
      if (serveOptions === undefined)
        return yield* Effect.die("Bundled service did not register a server");
      const registered = serveOptions;
      const response = yield* Effect.tryPromise(() =>
        registered.handler(
          new Request("http://127.0.0.1/hello", {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ),
      );
      expect(response.status).toBe(200);
      expect(fetchCalls).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
