import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { create as createStack } from "@supabase/stack/effect";
import { Data, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { homedir, tmpdir } from "node:os";

import { spawnSupabase } from "../../../../tests/helpers/cli.ts";
import { bundleStackFunctionsServeMainTemplate } from "../../../command-internal/stack-functions-bundler.ts";
import { generateGoJwt } from "../../../command-internal/go-jwt.ts";

const jwtSecret = "functions-serve-stack-e2e-secret-at-least-32-characters";
const nativeSupported =
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) ||
  (process.platform === "darwin" && process.arch === "arm64");

class FunctionsServeE2eError extends Data.TaggedError("FunctionsServeE2eError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const Payload = Schema.Struct({
  value: Schema.NullOr(Schema.String),
  anon: Schema.Boolean,
  service: Schema.Boolean,
  databaseUrl: Schema.NullOr(Schema.String),
});

const fixture = Effect.fn("FunctionsServeE2e.fixture")(function* (
  runtime: "native" | "docker",
  included: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Linux Edge Runtime overlays /tmp with a private worker filesystem, so native functions need a visible host path.
  const root = yield* fs.makeTempDirectoryScoped({
    ...(runtime === "native" && process.platform === "linux" ? { directory: homedir() } : {}),
    prefix: `functions-serve-${runtime}-`,
  });
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "functions-serve-home-" });
  const functionsRoot = path.join(root, "supabase", "functions");
  yield* fs.makeDirectory(path.join(functionsRoot, "hello"), { recursive: true });
  yield* fs.writeFileString(
    path.join(root, "supabase", "config.toml"),
    'project_id = "functions-serve-e2e"\n[experimental]\nstack = true\n[db]\nmajor_version = 17\n[edge_runtime]\nenabled = true\n',
  );
  yield* fs.writeFileString(
    path.join(functionsRoot, "hello", "index.ts"),
    `Deno.serve(() => Response.json({
      value: Deno.env.get("CUSTOM_VALUE") ?? null,
      anon: Boolean(Deno.env.get("SUPABASE_ANON_KEY")),
      service: Boolean(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")),
      databaseUrl: Deno.env.get("SUPABASE_DB_URL") ?? null,
    }));`,
  );
  yield* fs.writeFileString(path.join(root, "override.env"), "CUSTOM_VALUE=overridden\n");
  yield* fs.makeDirectory(path.join(home, "cache"), { recursive: true });
  const artifacts = path.join(tmpdir(), "supabase-stack-artifacts");
  yield* fs.makeDirectory(artifacts, { recursive: true });
  yield* fs.symlink(artifacts, path.join(home, "cache", "stack"));
  const stack = yield* createStack({
    projectRoot: root,
    stateRoot: path.join(home, "stacks"),
    cacheRoot: path.join(home, "cache", "stack"),
    runtime,
  });
  yield* Effect.addFinalizer(() =>
    stack.destroy.pipe(
      Effect.catch((cause) =>
        Effect.die(new FunctionsServeE2eError({ message: "stack cleanup failed", cause })),
      ),
    ),
  );
  const bootstrap = yield* bundleStackFunctionsServeMainTemplate();
  yield* stack.composition.supabase([
    {
      service: "database",
      config: {
        version: "17",
        databasePassword: Redacted.make("postgres"),
        jwtSecret: Redacted.make(jwtSecret),
        jwtExpiry: 3600,
      },
      endpoints: { sql: { port: "auto" } },
    },
    {
      service: "rest",
      config: { databaseUrl: "postgresql://placeholder", jwtSecret },
      endpoints: { http: { port: "auto" } },
    },
    ...(included
      ? [
          {
            service: "functions" as const,
            config: {
              functionsRoot,
              bootstrap,
              jwtSecret,
              verifyJwt: true,
              env: { CUSTOM_VALUE: "original" },
            },
            endpoints: { http: { port: "auto" as const } },
          },
        ]
      : []),
  ]);
  yield* stack.composition.start;
  const services = yield* stack.services.list;
  const rest = services.find((instance) => instance.service === "rest");
  const database = services.find((instance) => instance.service === "database");
  if (rest === undefined || database === undefined)
    return yield* Effect.die("fixture services missing");
  const apiUrl = (yield* rest.credentials()).apiUrl;
  const databaseUrl = (yield* database.credentials({ from: "runtime" })).databaseUrl;
  if (apiUrl === undefined || databaseUrl === undefined)
    return yield* Effect.die("fixture URLs missing");
  if (!included) {
    const httpPort = (yield* rest.status).endpoints.find(({ name }) => name === "http")?.port;
    if (httpPort === undefined) return yield* Effect.die("API port missing");
    yield* stack.services.create({
      service: "functions",
      config: {
        functionsRoot,
        bootstrap,
        jwtSecret,
        verifyJwt: true,
        env: { CUSTOM_VALUE: "excluded" },
      },
      endpoints: { http: { port: httpPort } },
    });
  }
  return { root, home, stack, services: yield* stack.services.list, apiUrl, databaseUrl };
});

const serve = Effect.fn("FunctionsServeE2e.serve")(function* (
  root: string,
  home: string,
  flags: ReadonlyArray<string> = [],
) {
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        spawnSupabase(["functions", "serve", ...flags], {
          cwd: root,
          home,
          env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
          exitTimeoutMs: 120_000,
        }),
      catch: (cause) => new FunctionsServeE2eError({ message: "CLI spawn failed", cause }),
    }),
    (process) => Effect.sync(() => process.releaseOwned({ successOptOut: false })),
  );
  yield* Effect.tryPromise({
    try: () => child.waitForOutput(/Serving Functions at /, 120_000),
    catch: (cause) => new FunctionsServeE2eError({ message: "serve did not become ready", cause }),
  });
  return child;
});

const interrupt = Effect.fn("FunctionsServeE2e.interrupt")(function* (
  child: ReturnType<typeof spawnSupabase>,
) {
  yield* Effect.sync(() => child.kill("SIGINT"));
  const exit = yield* child.exitEffect(120_000);
  expect(exit.exitCode, `stdout:\n${child.stdout()}\nstderr:\n${child.stderr()}`).toBe(0);
});

const invoke = Effect.fn("FunctionsServeE2e.invoke")(function* (
  apiUrl: string,
  authenticated: boolean,
) {
  const http = yield* HttpClient.HttpClient;
  return yield* http.get(`${apiUrl}/functions/v1/hello`, {
    headers: authenticated ? { Authorization: `Bearer ${generateGoJwt(jwtSecret, "anon")}` } : {},
  });
});

const payload = Effect.fn("FunctionsServeE2e.payload")(function* (
  apiUrl: string,
  authenticated: boolean,
) {
  const response = yield* invoke(apiUrl, authenticated);
  expect(response.status).toBe(200);
  return yield* Schema.decodeUnknownEffect(Payload)(yield* response.json);
});

const layer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

describe("functions serve (stack e2e)", () => {
  for (const runtime of ["native", "docker"] as const) {
    if (runtime === "native" && !nativeSupported) continue;
    it.live(
      `attaches and restores temporary overrides on the ${runtime} Functions member`,
      () =>
        Effect.gen(function* () {
          const { root, home, stack, services, apiUrl, databaseUrl } = yield* fixture(
            runtime,
            true,
          );
          const functions = services.find((instance) => instance.service === "functions");
          if (functions?.service !== "functions") return yield* Effect.die("Functions missing");
          const saved = yield* functions.status;
          expect(saved.lifecycle).toBe("stopped");
          expect(saved.wakeEnabled).toBe(true);
          const composition = yield* stack.composition.describe;
          const plain = yield* serve(root, home);
          const active = yield* functions.status;
          expect(yield* payload(apiUrl, true)).toEqual({
            value: "original",
            anon: true,
            service: true,
            databaseUrl,
          });
          const fs = yield* FileSystem.FileSystem;
          const sourcePath = `${root}/supabase/functions/hello/index.ts`;
          const source = yield* fs.readFileString(sourcePath);
          yield* fs.writeFileString(
            sourcePath,
            source.replace('"CUSTOM_VALUE"', '"MISSING_VALUE"'),
          );
          expect((yield* payload(apiUrl, true)).value).toBeNull();
          yield* fs.writeFileString(sourcePath, source);
          yield* interrupt(plain);
          expect((yield* functions.status).launchId).toBe(active.launchId);
          expect((yield* invoke(apiUrl, false)).status).toBe(401);

          const overridden = yield* serve(root, home, [
            "--no-verify-jwt",
            "--env-file",
            "override.env",
          ]);
          expect(yield* payload(apiUrl, false)).toEqual({
            value: "overridden",
            anon: true,
            service: true,
            databaseUrl,
          });
          yield* interrupt(overridden);
          expect((yield* functions.status).config).toEqual(saved.config);
          expect((yield* invoke(apiUrl, false)).status).toBe(401);
          expect((yield* payload(apiUrl, true)).value).toBe("original");
          expect(yield* stack.composition.describe).toEqual(composition);
        }).pipe(Effect.provide(layer)),
      { timeout: 360_000 },
    );

    it.live(
      `removes temporary ${runtime} Functions and keeps it excluded on Ctrl-C`,
      () =>
        Effect.gen(function* () {
          const { root, home, stack, services, apiUrl, databaseUrl } = yield* fixture(
            runtime,
            false,
          );
          const composition = yield* stack.composition.describe;
          const database = services.find((instance) => instance.service === "database");
          if (database === undefined) return yield* Effect.die("Database missing");
          const databaseLaunch = (yield* database.status).launchId;
          const child = yield* serve(root, home);
          expect(yield* payload(apiUrl, true)).toEqual({
            value: null,
            anon: true,
            service: true,
            databaseUrl,
          });
          expect(yield* stack.composition.describe).toEqual(composition);
          expect(yield* stack.services.list).toHaveLength(services.length + 1);
          yield* interrupt(child);
          expect((yield* stack.services.list).map(({ id }) => id).sort()).toEqual(
            services.map(({ id }) => id).sort(),
          );
          expect(yield* stack.composition.describe).toEqual(composition);
          expect((yield* database.status).launchId).toBe(databaseLaunch);
          expect((yield* invoke(apiUrl, false)).status).toBe(404);
          const http = yield* HttpClient.HttpClient;
          expect((yield* http.get(`${apiUrl}/rest/v1/`)).status).toBe(200);
        }).pipe(Effect.provide(layer)),
      { timeout: 360_000 },
    );
  }
});
