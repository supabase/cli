import { createContext, SourceTextModule } from "node:vm";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Data, Deferred, Effect, Exit, Predicate, Schema, Scope } from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

type ServeOptions = {
  readonly handler: (request: Request) => Promise<Response>;
  readonly onListen: () => void;
};
type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

class InvalidWorkerCreation extends Data.Error {}
class InvalidWorkerResponse extends Data.Error {}
class WorkerRequestCancelled extends Data.Error {}
class NotFoundError extends Data.Error {}
class WorkerAlreadyRetired extends Data.Error {}
class BootstrapLoadError extends Data.TaggedError("BootstrapLoadError")<{
  readonly cause: unknown;
}> {}

type LoadOptions = {
  readonly errors?: Record<string, abstract new (...args: never[]) => Error>;
  readonly fetchImpl?: FetchImplementation;
  readonly creationError?: unknown;
  readonly onCreate?: () => void;
  readonly creation?: Promise<{ fetch(request: Request): Promise<Response> }>;
  readonly createWorker?: () => { fetch(request: Request): Promise<Response> };
  readonly lstatError?: unknown;
  readonly metricError?: unknown;
};

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const load = Effect.fnUntraced(function* (
  bundle: string,
  env: Record<string, string>,
  worker: Record<string, unknown>,
  {
    errors = {},
    fetchImpl = fetch,
    creationError,
    onCreate = () => undefined,
    creation,
    createWorker,
    lstatError,
    metricError,
  }: LoadOptions = {},
) {
  let options: ServeOptions | undefined;
  const state: { createOptions?: Record<string, unknown> } = {};
  const envRecord = { ...env };
  const sandbox = {
    Deno: {
      env: { get: (name: string) => envRecord[name], toObject: () => envRecord },
      cwd: () => "/functions",
      lstat: () =>
        lstatError === undefined
          ? Promise.resolve({ isFile: true, isDirectory: false, isSymlink: false })
          : Promise.reject(lstatError),
      makeTempDirSync: () => "/tmp/worker",
      errors,
      version: { deno: "test" },
      serve: (value: ServeOptions) => {
        options = value;
      },
    },
    EdgeRuntime: {
      applySupabaseTag: (source: Request, target: Request) =>
        target.headers.set("x-tag", source.headers.get("x-tag") ?? ""),
      getRuntimeMetrics: () =>
        metricError === undefined ? Promise.resolve({ requests: 1 }) : Promise.reject(metricError),
      userWorkers: {
        create: (value: Record<string, unknown>) => {
          state.createOptions = value;
          onCreate();
          if (creation !== undefined) return creation;
          if (createWorker !== undefined) return Promise.resolve(createWorker());
          return creationError === undefined
            ? Promise.resolve(worker as { fetch(request: Request): Promise<Response> })
            : Promise.reject(creationError);
        },
      },
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
    fetch: fetchImpl,
    TextEncoder,
    TextDecoder,
    structuredClone,
  };
  const module = new SourceTextModule(bundle, {
    context: createContext(sandbox),
    identifier: "cli-serve.main.bundle.js",
  });
  yield* Effect.tryPromise({
    try: () =>
      module.link(() => {
        throw new Error("unexpected external import");
      }),
    catch: (cause) => new BootstrapLoadError({ cause }),
  });
  yield* Effect.tryPromise({
    try: () => module.evaluate(),
    catch: (cause) => new BootstrapLoadError({ cause }),
  });
  if (options === undefined) {
    return yield* new BootstrapLoadError({ cause: "bootstrap did not register server" });
  }
  return { options, envRecord, state };
});

const baseEnv = (config: string) => ({
  SUPABASE_INTERNAL_HOST_PORT: "8081",
  SUPABASE_INTERNAL_JWT_SECRET: "secret",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_INTERNAL_FUNCTIONS_CONFIG: config,
  SUPABASE_INTERNAL_FUNCTIONS_ROOT: "/functions",
});

const okWorker = { fetch: () => Promise.resolve(new Response("ok")) };

describe("CLI functions bootstrap bundle", () => {
  it.effect("fails startup for missing URL and malformed required config", () =>
    Effect.gen(function* () {
      const bundle = yield* bundleServeMainTemplate();
      const config = yield* encodeJson({
        hello: {
          entrypointPath: "hello/index.ts",
          importMapPath: "",
          staticFiles: [],
          verifyJWT: false,
        },
      });
      const missingUrl = yield* Effect.exit(
        load(bundle, { ...baseEnv(config), SUPABASE_URL: "" }, okWorker),
      );
      expect(Exit.isFailure(missingUrl)).toBe(true);
      const malformedConfig = yield* Effect.exit(
        load(bundle, { ...baseEnv("{"), SUPABASE_INTERNAL_FUNCTIONS_CONFIG: "{" }, okWorker),
      );
      expect(Exit.isFailure(malformedConfig)).toBe(true);
    }),
  );

  it.effect("authenticates and forwards request, environment, and worker options", () =>
    Effect.gen(function* () {
      const bundle = yield* bundleServeMainTemplate();
      const config = yield* encodeJson({
        hello: {
          entrypointPath: "hello/index.ts",
          importMapPath: "",
          staticFiles: [],
          verifyJWT: true,
          env: { FUNCTION_ONLY: "yes", SUPABASE_BLOCKED: "no" },
        },
      });
      let received: Request | undefined;
      const loaded = yield* load(
        bundle,
        {
          ...baseEnv(config),
          KEEP: "yes",
          HOME: "hidden",
          SUPABASE_INTERNAL_SECRET_KEY: "internal",
        },
        {
          fetch: (request: Request) => {
            received = request;
            return Promise.resolve(new Response(request.body));
          },
        },
      );
      const token = yield* Effect.promise(() =>
        new SignJWT({ sub: "test" })
          .setProtectedHeader({ alg: "HS256" })
          .sign(new TextEncoder().encode("secret")),
      );
      const response = yield* Effect.promise(() =>
        loaded.options.handler(
          new Request("http://localhost/hello", {
            method: "POST",
            body: "body",
            headers: { Authorization: `Bearer ${token}`, "sb-api-key": "remove", "x-tag": "tag" },
          }),
        ),
      );
      expect(response.status).toBe(200);
      expect(received?.headers.get("sb-api-key")).toBeNull();
      expect(received?.headers.get("x-tag")).toBe("tag");
      expect(yield* Effect.promise(() => response.text())).toBe("body");
      expect(loaded.state.createOptions?.envVars).toEqual(
        expect.arrayContaining([
          ["KEEP", "yes"],
          ["FUNCTION_ONLY", "yes"],
        ]),
      );
    }),
  );

  it.effect("rejects an invalid token", () =>
    Effect.gen(function* () {
      const bundle = yield* bundleServeMainTemplate();
      const config = yield* encodeJson({
        hello: {
          entrypointPath: "hello/index.ts",
          importMapPath: "",
          staticFiles: [],
          verifyJWT: true,
        },
      });
      const loaded = yield* load(bundle, baseEnv(config), {
        fetch: () => Promise.resolve(new Response("should not run")),
      });
      const response = yield* Effect.promise(() =>
        loaded.options.handler(
          new Request("http://localhost/hello", { headers: { Authorization: "Bearer invalid" } }),
        ),
      );
      expect(response.status).toBe(401);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: "UNAUTHORIZED_INVALID_JWT_FORMAT",
      });
    }),
  );

  it.effect("retains non-abort handler failures", () =>
    Effect.gen(function* () {
      const bundle = yield* bundleServeMainTemplate();
      const metricError = new Error("metrics unavailable");
      const loaded = yield* load(bundle, baseEnv("{}"), okWorker, {
        metricError,
      });
      const exit = yield* Effect.exit(
        Effect.promise(() =>
          loaded.options.handler(new Request("http://localhost/_internal/metric")),
        ),
      );
      const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(Predicate.isTagged(failure, "BootstrapOperationError")).toBe(true);
      expect(failure).toMatchObject({ cause: metricError });
    }),
  );

  it.effect.each([
    {
      name: "InvalidWorkerCreation",
      ErrorType: InvalidWorkerCreation,
      status: 503,
      code: "BOOT_ERROR",
    },
    {
      name: "InvalidWorkerResponse",
      ErrorType: InvalidWorkerResponse,
      status: 500,
      code: "WORKER_ERROR",
    },
    {
      name: "WorkerRequestCancelled",
      ErrorType: WorkerRequestCancelled,
      status: 546,
      code: "WORKER_LIMIT",
    },
  ])("maps $name worker failure to the runtime response", ({ ErrorType, status, code }) =>
    Effect.gen(function* () {
      const bundle = yield* bundleServeMainTemplate();
      const config = yield* encodeJson({
        hello: {
          entrypointPath: "hello/index.ts",
          importMapPath: "",
          staticFiles: ["public/**"],
          verifyJWT: false,
        },
      });
      const failure = new ErrorType();
      const loaded = yield* load(
        bundle,
        baseEnv(config),
        {
          fetch: () => Promise.reject(failure),
        },
        {
          errors: { InvalidWorkerCreation, InvalidWorkerResponse, WorkerRequestCancelled },
          creationError: ErrorType === InvalidWorkerCreation ? failure : undefined,
        },
      );
      const response = yield* Effect.promise(() =>
        loaded.options.handler(new Request("http://localhost/hello")),
      );
      expect(response.status).toBe(status);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ code });
    }),
  );

  describe("retired worker dispatch", () => {
    const config = {
      hello: {
        entrypointPath: "hello/index.ts",
        importMapPath: "",
        staticFiles: [],
        verifyJWT: false,
      },
    };
    // Every create() hands out a distinct worker: worker n always rejects with failures[n - 1] when
    // one is given, otherwise it answers with its own number so the response names the worker.
    const serve = Effect.fnUntraced(function* (failures: ReadonlyArray<Error>) {
      let creates = 0;
      const loaded = yield* load(
        yield* bundleServeMainTemplate(),
        baseEnv(yield* encodeJson(config)),
        {},
        {
          errors: { WorkerAlreadyRetired, InvalidWorkerResponse },
          createWorker: () => {
            const worker = ++creates;
            const failure = failures[worker - 1];
            return {
              fetch: (request: Request) =>
                failure !== undefined
                  ? Promise.reject(failure)
                  : request
                      .text()
                      .then(
                        (text) => new Response(`fn-ok worker-${worker} ${request.method} ${text}`),
                      ),
            };
          },
        },
      );
      return { loaded, creates: () => creates };
    });

    it.effect("serves a bodyless request with a fresh worker after WorkerAlreadyRetired", () =>
      Effect.gen(function* () {
        const { loaded, creates } = yield* serve([new WorkerAlreadyRetired()]);
        const response = yield* Effect.promise(() =>
          loaded.options.handler(new Request("http://localhost/hello")),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe("fn-ok worker-2 GET ");
        expect(creates()).toBe(2);
      }),
    );

    it.effect("does not retry a second consecutive WorkerAlreadyRetired", () =>
      Effect.gen(function* () {
        const { loaded, creates } = yield* serve([
          new WorkerAlreadyRetired(),
          new WorkerAlreadyRetired(),
        ]);
        const response = yield* Effect.promise(() =>
          loaded.options.handler(new Request("http://localhost/hello")),
        );
        expect(response.status).toBe(500);
        expect(creates()).toBe(2);
      }),
    );

    it.effect("does not retry other worker failures", () =>
      Effect.gen(function* () {
        const { loaded, creates } = yield* serve([new InvalidWorkerResponse()]);
        const response = yield* Effect.promise(() =>
          loaded.options.handler(new Request("http://localhost/hello")),
        );
        expect(response.status).toBe(500);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          code: "WORKER_ERROR",
        });
        expect(creates()).toBe(1);
      }),
    );

    it.effect("does not replay a request whose body was already forwarded", () =>
      Effect.gen(function* () {
        const { loaded, creates } = yield* serve([new WorkerAlreadyRetired()]);
        const response = yield* Effect.promise(() =>
          loaded.options.handler(
            new Request("http://localhost/hello", { method: "POST", body: "payload" }),
          ),
        );
        expect(response.status).toBe(500);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          code: "Internal Server Error",
        });
        expect(creates()).toBe(1);
      }),
    );
  });

  describe("request body ownership", () => {
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
    const functionConfig = (verifyJWT: boolean) =>
      encodeJson({
        hello: { entrypointPath: "hello/index.ts", importMapPath: "", staticFiles: [], verifyJWT },
      });

    it.effect("reads the rest of a request body the worker abandons", () =>
      Effect.gen(function* () {
        const loaded = yield* load(
          yield* bundleServeMainTemplate(),
          baseEnv(yield* functionConfig(false)),
          {
            fetch: (request: Request) => {
              const reader = request.body?.getReader();
              return Promise.resolve(reader?.read()).then(() => {
                // Not awaited: if the body were shared with the incoming request again, Bun
                // would never settle this cancel and the test would hang instead of failing.
                void reader?.cancel();
                return new Response("rejected", { status: 400 });
              });
            },
          },
        );
        const { body, progress } = upload();

        const response = yield* Effect.promise(() =>
          loaded.options.handler(
            new Request("http://localhost/hello", { method: "POST", body, duplex: "half" }),
          ),
        );

        expect(progress).toEqual({ readToEnd: true, cancelled: false });
        expect(response.status).toBe(400);
        expect(yield* Effect.promise(() => response.text())).toBe("rejected");
      }),
    );

    it.effect("settles an aborted request while the abandoned body read is pending", () =>
      Effect.gen(function* () {
        const readPending = yield* Deferred.make<void>();
        const hungRead = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.interrupt(hungRead));
        const pendingRead = Effect.runPromiseWith(yield* Effect.context<never>())(
          Deferred.await(hungRead),
        );
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
          pull: (streamController) => {
            pulls += 1;
            if (pulls === 1) {
              streamController.enqueue(new Uint8Array([1]));
              return;
            }
            Deferred.doneUnsafe(readPending, Effect.void);
            return pendingRead;
          },
        });
        const loaded = yield* load(
          yield* bundleServeMainTemplate(),
          baseEnv(yield* functionConfig(false)),
          {
            fetch: () => Promise.resolve(new Response("worker should not run")),
          },
        );
        const requestScope = yield* Scope.fork(yield* Effect.scope);
        const signal = yield* Scope.provide(Effect.abortSignal, requestScope);
        const pending = loaded.options.handler(
          new Request("http://localhost/missing", {
            method: "POST",
            body,
            duplex: "half",
            signal,
          }),
        );

        yield* Deferred.await(readPending);
        yield* Scope.close(requestScope, Exit.void);

        expect(yield* Effect.promise(() => pending)).toMatchObject({ status: 499 });
      }),
    );

    it.effect.each([
      ["an invalid token", "/hello", 401],
      ["an unknown function", "/missing", 404],
    ] as const)("reads the whole upload before rejecting %s", ([, path, status]) =>
      Effect.gen(function* () {
        const loaded = yield* load(
          yield* bundleServeMainTemplate(),
          baseEnv(yield* functionConfig(true)),
          {
            fetch: () => Promise.resolve(new Response("should not run")),
          },
        );
        const { body, progress } = upload();

        const response = yield* Effect.promise(() =>
          loaded.options.handler(
            new Request(`http://localhost${path}`, {
              method: "POST",
              body,
              duplex: "half",
              headers: { Authorization: "Bearer invalid" },
            }),
          ),
        );

        expect(progress).toEqual({ readToEnd: true, cancelled: false });
        expect(response.status).toBe(status);
      }),
    );
  });

  it.effect("does not fetch after an aborted pending worker creation", () =>
    Effect.gen(function* () {
      const bundle = yield* bundleServeMainTemplate();
      const config = yield* encodeJson({
        hello: {
          entrypointPath: "hello/index.ts",
          importMapPath: "",
          staticFiles: [],
          verifyJWT: false,
        },
      });
      const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
      let fetchCalls = 0;
      const workerCreation = yield* Deferred.make<{ fetch(request: Request): Promise<Response> }>();
      yield* Effect.addFinalizer(() => Deferred.interrupt(workerCreation));
      const createCalled = yield* Deferred.make<void>();
      const workerReady = runPromise(Deferred.await(workerCreation));
      const loaded = yield* load(
        bundle,
        baseEnv(config),
        {
          fetch: () => {
            fetchCalls += 1;
            return Promise.resolve(new Response("unreachable"));
          },
        },
        {
          onCreate: () => {
            Deferred.doneUnsafe(createCalled, Effect.void);
          },
          creation: workerReady,
        },
      );
      const requestScope = yield* Scope.fork(yield* Effect.scope);
      const signal = yield* Scope.provide(Effect.abortSignal, requestScope);
      const pending = loaded.options.handler(new Request("http://localhost/hello", { signal }));
      yield* Deferred.await(createCalled);
      yield* Scope.close(requestScope, Exit.void);
      expect(yield* Effect.promise(() => pending)).toMatchObject({ status: 499 });
      yield* Deferred.succeed(workerCreation, {
        fetch: () => {
          fetchCalls += 1;
          return Promise.resolve(new Response("unreachable"));
        },
      });
      yield* Effect.promise(() => workerReady);
      expect(fetchCalls).toBe(0);
    }),
  );

  it.effect("authenticates ES256 with injected keys and owned remote fallback", () =>
    Effect.gen(function* () {
      const { publicKey, privateKey } = yield* Effect.promise(() => generateKeyPair("ES256"));
      const publicJwk = yield* Effect.promise(() => exportJWK(publicKey));
      const token = yield* Effect.promise(() =>
        new SignJWT({ sub: "test" })
          .setProtectedHeader({ alg: "ES256", kid: "test-key" })
          .sign(privateKey),
      );
      const config = yield* encodeJson({
        hello: {
          entrypointPath: "hello/index.ts",
          importMapPath: "",
          staticFiles: [],
          verifyJWT: true,
        },
      });
      const keys = yield* encodeJson({
        keys: [{ ...publicJwk, kid: "test-key", alg: "ES256", use: "sig" }],
      });
      const bundle = yield* bundleServeMainTemplate();
      const injected = yield* load(
        bundle,
        {
          ...baseEnv(config),
          SUPABASE_JWKS: keys,
        },
        okWorker,
      );
      const injectedResponse = yield* Effect.promise(() =>
        injected.options.handler(
          new Request("http://localhost/hello", { headers: { Authorization: `Bearer ${token}` } }),
        ),
      );
      expect(injectedResponse.status).toBe(200);

      for (const jwks of [undefined, "{"] as const) {
        let fetchCalls = 0;
        const remote = yield* load(
          bundle,
          {
            ...baseEnv(config),
            ...(jwks === undefined ? {} : { SUPABASE_JWKS: jwks }),
          },
          okWorker,
          {
            fetchImpl: () => {
              fetchCalls += 1;
              return Promise.resolve(
                new Response(keys, { headers: { "content-type": "application/json" } }),
              );
            },
          },
        );
        const remoteResponse = yield* Effect.promise(() =>
          remote.options.handler(
            new Request("http://localhost/hello", {
              headers: { Authorization: `Bearer ${token}` },
            }),
          ),
        );
        expect(remoteResponse.status).toBe(200);
        const secondResponse = yield* Effect.promise(() =>
          remote.options.handler(
            new Request("http://localhost/hello", {
              headers: { Authorization: `Bearer ${token}` },
            }),
          ),
        );
        expect(secondResponse.status).toBe(200);
        expect(fetchCalls).toBe(1);
      }
    }),
  );

  it.effect("uses package discovery when package.json is present or lstat reports NotFound", () =>
    Effect.gen(function* () {
      const bundle = yield* bundleServeMainTemplate();
      const config = yield* encodeJson({
        hello: {
          entrypointPath: "hello/index.ts",
          importMapPath: "",
          staticFiles: [],
          verifyJWT: false,
        },
      });
      const permissionFailure = yield* load(bundle, baseEnv(config), okWorker, {
        lstatError: new Error("permission denied"),
      });
      yield* Effect.promise(() =>
        permissionFailure.options.handler(new Request("http://localhost/hello")),
      );
      expect(permissionFailure.state.createOptions?.noNpm).toBe(false);

      const missing = yield* load(bundle, baseEnv(config), okWorker, {
        errors: { NotFound: NotFoundError },
        lstatError: new NotFoundError(),
      });
      yield* Effect.promise(() => missing.options.handler(new Request("http://localhost/hello")));
      expect(missing.state.createOptions?.noNpm).toBe(true);
    }),
  );
});
