import { createContext, SourceTextModule } from "node:vm";
import { Effect, FileSystem, Path, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { SignJWT } from "jose";
import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

describe("stack-owned functions bootstrap", () => {
  it.live("produces an executable offline service with the expected runtime contract", () =>
    Effect.gen(function* () {
      type ServeOptions = {
        readonly handler: (request: Request) => Promise<Response>;
        readonly onListen: () => void;
      };

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem | Path.Path>());
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-bootstrap-" });
      yield* fs.makeDirectory(path.join(root, "hello"));
      yield* fs.writeFileString(path.join(root, "hello", "index.ts"), "export default 1");
      const importMapPath = path.join(root, "import-map.json");
      yield* fs.writeFileString(importMapPath, '{"imports":{}}');
      const secret = "bootstrap-test\nsecret";
      let serveOptions: ServeOptions | undefined;
      let workerEnvironment: ReadonlyArray<readonly [string, string]> | undefined;
      let workerContext: Readonly<Record<string, unknown>> | undefined;
      const multiline = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        MULTILINE_VALUE: "first line\nsecond line",
        SUPABASE_INTERNAL_JWT_SECRET: secret,
      });
      const functionsConfig = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        $default: { import_map_root: importMapPath },
      });
      const bundled = yield* bundleServeMainTemplate;
      const sandbox = {
        Deno: {
          env: {
            get: (name: string) =>
              name === "SUPABASE_INTERNAL_FUNCTIONS_ROOT"
                ? root
                : name === "SUPABASE_INTERNAL_FUNCTIONS_CONFIG"
                  ? functionsConfig
                  : name === "SUPABASE_INTERNAL_IMPORT_MAP_SOURCE"
                    ? importMapPath
                    : name === "SUPABASE_INTERNAL_MULTILINE_ENV"
                      ? multiline
                      : undefined,
            toObject: () => ({ SUPABASE_INTERNAL_MULTILINE_ENV: multiline }),
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
            create: (options: {
              envVars: ReadonlyArray<readonly [string, string]>;
              context: Readonly<Record<string, unknown>>;
            }) => {
              workerEnvironment = options.envVars;
              workerContext = options.context;
              return Promise.resolve({ fetch: () => Promise.resolve(new Response("hello")) });
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
      const valid = yield* invoke(token);
      expect(valid.status).toBe(200);
      expect(yield* Effect.tryPromise(() => valid.text())).toBe("hello");
      expect(workerEnvironment).toContainEqual(["MULTILINE_VALUE", "first line\nsecond line"]);
      expect(workerEnvironment).not.toContainEqual(["SUPABASE_INTERNAL_MULTILINE_ENV", multiline]);
      expect(workerContext).toMatchObject({ useReadSyncFileAPI: true, importMapPath });
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
});
