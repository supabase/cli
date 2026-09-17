import { createContext, SourceTextModule } from "node:vm";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

type ServeOptions = {
  readonly handler: (request: Request) => Promise<Response>;
  readonly onListen: () => void;
};
type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

class InvalidWorkerCreation extends Error {}
class InvalidWorkerResponse extends Error {}
class WorkerRequestCancelled extends Error {}
class NotFoundError extends Error {}

type LoadOptions = {
  readonly errors?: Record<string, abstract new (...args: never[]) => Error>;
  readonly fetchImpl?: FetchImplementation;
  readonly creationError?: unknown;
  readonly onCreate?: () => void;
  readonly creation?: Promise<{ fetch(request: Request): Promise<Response> }>;
  readonly lstatError?: unknown;
  readonly metricError?: unknown;
};

const load = async (
  bundle: string,
  env: Record<string, string>,
  worker: Record<string, unknown>,
  {
    errors = {},
    fetchImpl = fetch,
    creationError,
    onCreate = () => undefined,
    creation,
    lstatError,
    metricError,
  }: LoadOptions = {},
) => {
  let options: ServeOptions | undefined;
  const state: { createOptions?: Record<string, unknown> } = {};
  const envRecord = { ...env };
  const sandbox = {
    Deno: {
      env: { get: (name: string) => envRecord[name], toObject: () => envRecord },
      cwd: () => "/functions",
      lstat: async () => {
        if (lstatError !== undefined) throw lstatError;
        return { isFile: true, isDirectory: false, isSymlink: false };
      },
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
          return creationError === undefined
            ? Promise.resolve(worker as { fetch(request: Request): Promise<Response> })
            : Promise.reject(creationError);
        },
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
  await module.link(() => {
    throw new Error("unexpected external import");
  });
  await module.evaluate();
  if (options === undefined) throw new Error("bootstrap did not register server");
  return { options, envRecord, state };
};

const baseEnv = (config: string) => ({
  SUPABASE_INTERNAL_HOST_PORT: "8081",
  SUPABASE_INTERNAL_JWT_SECRET: "secret",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_INTERNAL_FUNCTIONS_CONFIG: config,
  SUPABASE_INTERNAL_FUNCTIONS_ROOT: "/functions",
});

describe("CLI functions bootstrap bundle", () => {
  it("fails startup for missing URL and malformed required config", async () => {
    const bundle = await Effect.runPromise(bundleServeMainTemplate);
    const config = JSON.stringify({
      hello: {
        entrypointPath: "hello/index.ts",
        importMapPath: "",
        staticFiles: [],
        verifyJWT: false,
      },
    });
    await expect(
      load(
        bundle,
        { ...baseEnv(config), SUPABASE_URL: "" },
        { fetch: async () => new Response("ok") },
      ),
    ).rejects.toThrow();
    await expect(
      load(
        bundle,
        { ...baseEnv("{"), SUPABASE_INTERNAL_FUNCTIONS_CONFIG: "{" },
        { fetch: async () => new Response("ok") },
      ),
    ).rejects.toThrow();
  });

  it("authenticates and forwards request, environment, and worker options", async () => {
    const bundle = await Effect.runPromise(bundleServeMainTemplate);
    const config = JSON.stringify({
      hello: {
        entrypointPath: "hello/index.ts",
        importMapPath: "",
        staticFiles: [],
        verifyJWT: true,
        env: { FUNCTION_ONLY: "yes", SUPABASE_BLOCKED: "no" },
      },
    });
    let received: Request | undefined;
    const loaded = await load(
      bundle,
      { ...baseEnv(config), KEEP: "yes", HOME: "hidden", SUPABASE_INTERNAL_SECRET_KEY: "internal" },
      {
        fetch: async (request: Request) => {
          received = request;
          return new Response(request.body);
        },
      },
    );
    const token = await new SignJWT({ sub: "test" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("secret"));
    const response = await loaded.options.handler(
      new Request("http://localhost/hello", {
        method: "POST",
        body: "body",
        headers: { Authorization: `Bearer ${token}`, "sb-api-key": "remove", "x-tag": "tag" },
      }),
    );
    expect(response.status).toBe(200);
    expect(received?.headers.get("sb-api-key")).toBeNull();
    expect(received?.headers.get("x-tag")).toBe("tag");
    expect(await response.text()).toBe("body");
    expect(loaded.state.createOptions?.envVars).toEqual(
      expect.arrayContaining([
        ["KEEP", "yes"],
        ["FUNCTION_ONLY", "yes"],
      ]),
    );
  });

  it("rejects an invalid token", async () => {
    const bundle = await Effect.runPromise(bundleServeMainTemplate);
    const config = JSON.stringify({
      hello: {
        entrypointPath: "hello/index.ts",
        importMapPath: "",
        staticFiles: [],
        verifyJWT: true,
      },
    });
    const loaded = await load(bundle, baseEnv(config), {
      fetch: async () => new Response("should not run"),
    });
    const response = await loaded.options.handler(
      new Request("http://localhost/hello", { headers: { Authorization: "Bearer invalid" } }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED_INVALID_JWT_FORMAT" });
  });

  it("retains non-abort handler failures", async () => {
    const bundle = await Effect.runPromise(bundleServeMainTemplate);
    const metricError = new Error("metrics unavailable");
    const loaded = await load(
      bundle,
      baseEnv("{}"),
      { fetch: async () => new Response("ok") },
      {
        metricError,
      },
    );
    const failure = await loaded.options
      .handler(new Request("http://localhost/_internal/metric"))
      .catch((error) => error);
    expect(failure).toMatchObject({ _tag: "BootstrapOperationError", cause: metricError });
  });

  it.each([
    [InvalidWorkerCreation, 503, "BOOT_ERROR"],
    [InvalidWorkerResponse, 500, "WORKER_ERROR"],
    [WorkerRequestCancelled, 546, "WORKER_LIMIT"],
  ] as const)("maps %s worker failure to the runtime response", async (ErrorType, status, code) => {
    const bundle = await Effect.runPromise(bundleServeMainTemplate);
    const config = JSON.stringify({
      hello: {
        entrypointPath: "hello/index.ts",
        importMapPath: "",
        staticFiles: ["public/**"],
        verifyJWT: false,
      },
    });
    const failure = new ErrorType();
    const loaded = await load(
      bundle,
      baseEnv(config),
      {
        fetch: async () => {
          throw failure;
        },
      },
      {
        errors: { InvalidWorkerCreation, InvalidWorkerResponse, WorkerRequestCancelled },
        creationError: ErrorType === InvalidWorkerCreation ? failure : undefined,
      },
    );
    const response = await loaded.options.handler(new Request("http://localhost/hello"));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });

  it("does not fetch after an aborted pending worker creation", async () => {
    const bundle = await Effect.runPromise(bundleServeMainTemplate);
    const config = JSON.stringify({
      hello: {
        entrypointPath: "hello/index.ts",
        importMapPath: "",
        staticFiles: [],
        verifyJWT: false,
      },
    });
    let fetchCalls = 0;
    let resolveCreation!: (worker: { fetch(request: Request): Promise<Response> }) => void;
    const workerReady = new Promise<{ fetch(request: Request): Promise<Response> }>((resolve) => {
      resolveCreation = resolve;
    });
    let createInvoked!: () => void;
    const createCalled = new Promise<void>((resolve) => {
      createInvoked = resolve;
    });
    const loaded = await load(
      bundle,
      baseEnv(config),
      {
        fetch: async () => {
          fetchCalls += 1;
          return new Response("unreachable");
        },
      },
      { onCreate: createInvoked, creation: workerReady },
    );
    const controller = new AbortController();
    const pending = loaded.options.handler(
      new Request("http://localhost/hello", { signal: controller.signal }),
    );
    await createCalled;
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: 499 });
    resolveCreation({
      fetch: async () => {
        fetchCalls += 1;
        return new Response("unreachable");
      },
    });
    await workerReady;
    expect(fetchCalls).toBe(0);
  });

  it("authenticates ES256 with injected keys and owned remote fallback", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    const token = await new SignJWT({ sub: "test" })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .sign(privateKey);
    const config = JSON.stringify({
      hello: {
        entrypointPath: "hello/index.ts",
        importMapPath: "",
        staticFiles: [],
        verifyJWT: true,
      },
    });
    const bundle = await Effect.runPromise(bundleServeMainTemplate);
    const worker = { fetch: async () => new Response("ok") };
    const injected = await load(
      bundle,
      {
        ...baseEnv(config),
        SUPABASE_JWKS: JSON.stringify({
          keys: [{ ...publicJwk, kid: "test-key", alg: "ES256", use: "sig" }],
        }),
      },
      worker,
    );
    const injectedResponse = await injected.options.handler(
      new Request("http://localhost/hello", { headers: { Authorization: `Bearer ${token}` } }),
    );
    expect(injectedResponse.status).toBe(200);

    for (const jwks of [undefined, "{"] as const) {
      let fetchCalls = 0;
      const remote = await load(
        bundle,
        {
          ...baseEnv(config),
          ...(jwks === undefined ? {} : { SUPABASE_JWKS: jwks }),
        },
        worker,
        {
          fetchImpl: async () => {
            fetchCalls += 1;
            return new Response(
              JSON.stringify({
                keys: [{ ...publicJwk, kid: "test-key", alg: "ES256", use: "sig" }],
              }),
              { headers: { "content-type": "application/json" } },
            );
          },
        },
      );
      const remoteResponse = await remote.options.handler(
        new Request("http://localhost/hello", { headers: { Authorization: `Bearer ${token}` } }),
      );
      expect(remoteResponse.status).toBe(200);
      const secondResponse = await remote.options.handler(
        new Request("http://localhost/hello", { headers: { Authorization: `Bearer ${token}` } }),
      );
      expect(secondResponse.status).toBe(200);
      expect(fetchCalls).toBe(1);
    }
  });

  it("uses package discovery when package.json is present or lstat reports NotFound", async () => {
    const bundle = await Effect.runPromise(bundleServeMainTemplate);
    const config = JSON.stringify({
      hello: {
        entrypointPath: "hello/index.ts",
        importMapPath: "",
        staticFiles: [],
        verifyJWT: false,
      },
    });
    const worker = { fetch: async () => new Response("ok") };
    const permissionFailure = await load(bundle, baseEnv(config), worker, {
      lstatError: new Error("permission denied"),
    });
    await permissionFailure.options.handler(new Request("http://localhost/hello"));
    expect(permissionFailure.state.createOptions?.noNpm).toBe(false);

    const missing = await load(bundle, baseEnv(config), worker, {
      errors: { NotFound: NotFoundError },
      lstatError: new NotFoundError(),
    });
    await missing.options.handler(new Request("http://localhost/hello"));
    expect(missing.state.createOptions?.noNpm).toBe(true);
  });
});
