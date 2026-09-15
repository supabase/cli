import { createContext, SourceTextModule } from "node:vm";
import { Effect, FileSystem, Path } from "effect";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { SignJWT } from "jose";
import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

type ServeOptions = {
  readonly handler: (request: Request) => Promise<Response>;
  readonly onListen: () => void;
};

describe("stack-owned functions bootstrap", () => {
  it.live("produces an executable offline service with the expected runtime contract", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem | Path.Path>());
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-bootstrap-" });
      yield* fs.makeDirectory(path.join(root, "hello"));
      yield* fs.writeFileString(path.join(root, "hello", "index.ts"), "export default 1");
      const secret = "bootstrap-test-secret";
      const envRecord = {
        SUPABASE_INTERNAL_FUNCTIONS_ROOT: root,
        SUPABASE_INTERNAL_JWT_SECRET: secret,
        KEEP: "yes",
      };
      let createOptions: Record<string, unknown> | undefined;
      let received: Request | undefined;
      let serveOptions: ServeOptions | undefined;
      const bundled = yield* bundleServeMainTemplate;
      const sandbox = {
        Deno: {
          env: {
            get: (name: string) => envRecord[name as keyof typeof envRecord],
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
              return Promise.resolve({
                fetch: (request: Request) => {
                  received = request;
                  return Promise.resolve(new Response(request.body));
                },
              });
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("starts with malformed optional functions config", () =>
    Effect.gen(function* () {
      const bundled = yield* bundleServeMainTemplate;
      const envRecord = { SUPABASE_INTERNAL_FUNCTIONS_CONFIG: "{" };
      let serveOptions: ServeOptions | undefined;
      const sandbox = {
        Deno: {
          env: {
            get: (name: string) => envRecord[name as keyof typeof envRecord],
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
