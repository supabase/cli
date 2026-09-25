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
// oxlint-disable-next-line effecttsgo/extends-native-error -- stands in for Deno.errors.WorkerAlreadyRetired, matched by instanceof at the sandbox boundary.
class WorkerAlreadyRetired extends Error {}
// oxlint-disable-next-line effecttsgo/extends-native-error -- stands in for Deno.errors.InvalidWorkerResponse, matched by instanceof at the sandbox boundary.
class InvalidWorkerResponse extends Error {}

type TestWorker = { fetch(request: Request): Promise<Response> };

const serveSandboxed = (functionsConfig: string, createWorker: () => TestWorker) =>
  Effect.gen(function* () {
    const envRecord: Record<string, string> = {
      SUPABASE_INTERNAL_FUNCTIONS_ROOT: "/functions",
      SUPABASE_INTERNAL_FUNCTIONS_CONFIG: functionsConfig,
    };
    const bundled = yield* bundleServeMainTemplate;
    let serveOptions: ServeOptions | undefined;
    const sandbox = {
      Deno: {
        env: {
          get: (name: string) => envRecord[name],
          toObject: () => envRecord,
        },
        errors: { WorkerAlreadyRetired, InvalidWorkerResponse },
        lstat: (path: string) => {
          const isDirectory = path === "/functions" || path === "/functions/hello";
          const isFile = path === "/functions/hello/index.ts";
          return isDirectory || isFile
            ? Promise.resolve({ isDirectory, isFile, isSymlink: false })
            : Promise.reject(new MissingFixture());
        },
        realPath: (path: string) => Promise.resolve(path),
        readDir: () => Stream.toAsyncIterable(Stream.empty),
        makeTempDirSync: () => "/tmp/worker",
        version: { deno: "test" },
        serve: (options: ServeOptions) => {
          serveOptions = options;
        },
      },
      EdgeRuntime: {
        applySupabaseTag: () => undefined,
        userWorkers: { create: () => Promise.resolve(createWorker()) },
      },
      AbortController,
      AbortSignal,
      Headers,
      ReadableStream,
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
      identifier: "serve.main.sandboxed.bundle.js",
    });
    yield* Effect.tryPromise(() =>
      module.link(() => {
        throw new Error("Bundled service unexpectedly imported another module");
      }),
    );
    yield* Effect.tryPromise(() => module.evaluate());
    if (serveOptions === undefined)
      return yield* Effect.die("Bundled service did not register a server");
    return serveOptions.handler;
  });

const upload = (chunks = 4) => {
  const progress = { readToEnd: false, cancelled: false };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (sent === chunks) {
        progress.readToEnd = true;
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(1024));
    },
    cancel: () => {
      progress.cancelled = true;
    },
  });
  return { body, progress };
};

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
        ReadableStream,
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

  describe("retired worker dispatch", () => {
    // Every create() hands out a distinct worker: worker n always rejects with failures[n - 1] when
    // one is given, otherwise it answers with its own number so the response names the worker.
    const serve = (failures: ReadonlyArray<Error>) =>
      Effect.gen(function* () {
        let creates = 0;
        const handler = yield* serveSandboxed('{"hello":{"verifyJWT":false}}', () => {
          const worker = ++creates;
          const failure = failures[worker - 1];
          return {
            fetch: (request: Request) => {
              if (failure !== undefined) return Promise.reject(failure);
              return request
                .text()
                .then((body) => new Response(`fn-ok worker-${worker} ${request.method} ${body}`));
            },
          };
        });
        return { handler, creates: () => creates };
      });

    it.live("serves a bodyless request with a fresh worker after WorkerAlreadyRetired", () =>
      Effect.gen(function* () {
        const { handler, creates } = yield* serve([new WorkerAlreadyRetired()]);
        const response = yield* Effect.tryPromise(() =>
          handler(new Request("http://127.0.0.1/hello")),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.tryPromise(() => response.text())).toBe("fn-ok worker-2 GET ");
        expect(creates()).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.live("does not retry a second consecutive WorkerAlreadyRetired", () =>
      Effect.gen(function* () {
        const { handler, creates } = yield* serve([
          new WorkerAlreadyRetired(),
          new WorkerAlreadyRetired(),
        ]);
        const response = yield* Effect.tryPromise(() =>
          handler(new Request("http://127.0.0.1/hello")),
        );
        expect(response.status).toBe(500);
        expect(creates()).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.live("does not retry other worker failures", () =>
      Effect.gen(function* () {
        const { handler, creates } = yield* serve([new InvalidWorkerResponse()]);
        const response = yield* Effect.tryPromise(() =>
          handler(new Request("http://127.0.0.1/hello")),
        );
        expect(response.status).toBe(500);
        expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
          code: "WORKER_ERROR",
        });
        expect(creates()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.live("does not replay a request whose body was already forwarded", () =>
      Effect.gen(function* () {
        const { handler, creates } = yield* serve([new WorkerAlreadyRetired()]);
        const response = yield* Effect.tryPromise(() =>
          handler(new Request("http://127.0.0.1/hello", { method: "POST", body: "payload" })),
        );
        expect(response.status).toBe(500);
        expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
          code: "Internal Server Error",
        });
        expect(creates()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });

  describe("request body ownership", () => {
    it.live("reads the rest of a request body the worker abandons", () =>
      Effect.gen(function* () {
        const handler = yield* serveSandboxed('{"hello":{"verifyJWT":false}}', () => ({
          fetch: (request: Request) => {
            const reader = request.body?.getReader();
            return Promise.resolve(reader?.read()).then(() => {
              // Not awaited: if the body were shared with the incoming request again, Bun
              // would never settle this cancel and the test would hang instead of failing.
              void reader?.cancel();
              return new Response("rejected", { status: 400 });
            });
          },
        }));
        const { body, progress } = upload();

        const response = yield* Effect.tryPromise(() =>
          handler(new Request("http://127.0.0.1/hello", { method: "POST", body, duplex: "half" })),
        );

        expect(progress).toEqual({ readToEnd: true, cancelled: false });
        expect(response.status).toBe(400);
        expect(yield* Effect.tryPromise(() => response.text())).toBe("rejected");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live.each([
      ["an invalid token", "/hello", 401],
      ["an unknown function", "/missing", 404],
    ] as const)("reads the whole upload before rejecting %s", ([, path, status]) =>
      Effect.gen(function* () {
        const handler = yield* serveSandboxed('{"hello":{"verifyJWT":true}}', () => ({
          fetch: () => Promise.resolve(new Response("should not run")),
        }));
        const { body, progress } = upload();

        const response = yield* Effect.tryPromise(() =>
          handler(
            new Request(`http://127.0.0.1${path}`, {
              method: "POST",
              body,
              duplex: "half",
              headers: { Authorization: "Bearer invalid" },
            }),
          ),
        );

        expect(progress).toEqual({ readToEnd: true, cancelled: false });
        expect(response.status).toBe(status);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });
});
