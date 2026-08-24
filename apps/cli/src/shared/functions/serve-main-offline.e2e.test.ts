import { tmpdir } from "node:os";

import { BunFileSystem, BunHttpClient, BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "vitest";
import { Duration, Effect, FileSystem, Schedule, Stream } from "effect";
import * as EffectPath from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient } from "effect/unstable/http";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { PlatformError } from "effect/PlatformError";

import { LEGACY_START_KONG_YML_TEMPLATE } from "../../legacy/commands/start/templates/kong.yml.ts";
import { LEGACY_EDGE_RUNTIME_IMAGE } from "../../legacy/shared/legacy-edge-runtime-image.ts";
import { ensureImage, resolveDeadline } from "../../../tests/helpers/docker-image.ts";
import { dockerfileServiceImage } from "../services/dockerfile-images.ts";
import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

const { join } = Effect.runSync(EffectPath.Path.pipe(Effect.provide(BunPath.layer)));

const withFileSystem = <A>(
  effect: Effect.Effect<A, PlatformError, FileSystem.FileSystem>,
): Effect.Effect<A, PlatformError, never> => effect.pipe(Effect.provide(BunFileSystem.layer));

const makeDirectory = (path: string, recursive = false) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path, { recursive });
    }),
  );
const makeTempDirectory = (prefix: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory({ directory: tmpdir(), prefix });
    }),
  );
const remove = (path: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path, { recursive: true, force: true });
    }),
  );
const writeFileString = (path: string, contents: string) =>
  withFileSystem(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(path, contents);
    }),
  );

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCommand(
  command: string | ReadonlyArray<string>,
  argsOrOptions:
    | ReadonlyArray<string>
    | { readonly ignoreOutput?: boolean; readonly stdio?: string } = [],
  maybeOptions: {
    readonly ignoreOutput?: boolean;
    readonly stdio?: string;
  } = {},
): Effect.Effect<CommandResult, PlatformError, never> {
  const isArgs = (value: typeof argsOrOptions): value is ReadonlyArray<string> =>
    Array.isArray(value);
  const args = isArgs(argsOrOptions) ? [...argsOrOptions] : [];
  const options = isArgs(argsOrOptions) ? maybeOptions : argsOrOptions;
  const cmd = typeof command === "string" ? [command, ...args] : [...command];
  const executable = cmd[0];
  if (executable === undefined) {
    return Effect.die("command cannot be empty");
  }
  const captureOutput = options.ignoreOutput !== true && options.stdio !== "ignore";
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(executable, cmd.slice(1), {
          stdout: captureOutput ? "pipe" : "ignore",
          stderr: captureOutput ? "pipe" : "ignore",
        }),
      );
      const result = yield* Effect.all(
        {
          status: handle.exitCode,
          stdout: captureOutput
            ? Stream.mkString(Stream.decodeText(handle.stdout))
            : Effect.succeed(""),
          stderr: captureOutput
            ? Stream.mkString(Stream.decodeText(handle.stderr))
            : Effect.succeed(""),
        },
        { concurrency: "unbounded" },
      );
      return result;
    }),
  ).pipe(Effect.provide(BunServices.layer));
}

/**
 * Regression guard for supabase/supabase#45570: the edge-runtime worker bootstrap
 * template must boot with **no network access**. Before bundling, the template
 * imported `deno.land/std` and `jsr:` modules that Deno resolved over the network on
 * every start, so `functions serve` failed offline.
 *
 * This boots the real bundled template as an edge-runtime main service with
 * `--network none` and asserts it reaches the template's own "Serving functions"
 * log line without any remote fetch. The service is mounted at `/app` (read-only) so
 * `/root` stays writable for Deno's module cache — isolating the network as the only
 * variable (a control run of the unbundled template fails here with a DNS error).
 */

const dockerAvailable = await Effect.runPromise(
  runCommand(["docker", "info"], { ignoreOutput: true }).pipe(
    Effect.map((result) => result.status === 0),
    Effect.orElseSucceed(() => false),
  ),
);
// Cold-cache image resolution (up to one shared 90s resolveDeadline budget)
// runs inside the test body, ahead of the 60s startup wait — the test budget
// must cover both stacked, or a healthy near-cap pull trips vitest first.
const SERVE_OFFLINE_TEST_TIMEOUT_MS = 180_000;
const AUTH_FUNCTIONS_CONFIG = JSON.stringify({
  test: {
    entrypointPath: "/tmp/test/index.ts",
    importMapPath: "",
    staticFiles: [],
    verifyJWT: true,
  },
});
const MALFORMED_ENV_FUNCTIONS_CONFIG = JSON.stringify({
  test: {
    entrypointPath: "/tmp/test/index.ts",
    importMapPath: "",
    verifyJWT: true,
    env: 1,
  },
});
const KONG_FUNCTIONS_CONFIG = JSON.stringify({
  test: {
    entrypointPath: "/app/functions/custom/index.ts",
    importMapPath: "",
    verifyJWT: true,
  },
  custom: {
    entrypointPath: "/app/functions/custom/index.ts",
    importMapPath: "/app/import_map.json",
    verifyJWT: false,
    env: {
      SHARED: "function",
      FUNCTION_ONLY: "function",
      FUNCTION_SECRET: "must-not-appear-in-debug-logs",
    },
  },
});
const CUSTOM_FUNCTION = `Deno.serve(() => new Response("ok", {
  headers: {
    "X-Custom-Id": "abc123",
    "X-Shared": Deno.env.get("SHARED") ?? "",
    "X-Function-Only": Deno.env.get("FUNCTION_ONLY") ?? "",
    "X-Global-Only": Deno.env.get("GLOBAL_ONLY") ?? "",
    "Access-Control-Expose-Headers": "X-Custom-Id",
  },
}));`;

function jwtWithInvalidSignature(algorithm?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test-user" })).toString("base64url");
  return `${header}.${payload}.invalid`;
}

const authFailureCases = [
  {
    name: "missing authorization",
    code: "UNAUTHORIZED_NO_AUTH_HEADER",
    message: "Missing authorization header",
  },
  {
    name: "invalid JWT format",
    authorization: "Bearer not-a-jwt",
    code: "UNAUTHORIZED_INVALID_JWT_FORMAT",
    message: "Invalid JWT format",
  },
  {
    name: "missing JWT algorithm",
    authorization: `Bearer ${jwtWithInvalidSignature()}`,
    code: "UNAUTHORIZED_INVALID_JWT_FORMAT",
    message: "Invalid JWT format",
  },
  {
    name: "invalid legacy JWT",
    authorization: `Bearer ${jwtWithInvalidSignature("HS256")}`,
    code: "UNAUTHORIZED_LEGACY_JWT",
    message: "Invalid JWT",
  },
  {
    name: "invalid asymmetric JWT",
    authorization: `Bearer ${jwtWithInvalidSignature("ES256")}`,
    code: "UNAUTHORIZED_ASYMMETRIC_JWT",
    message: "Invalid JWT",
  },
  {
    name: "unsupported JWT algorithm",
    authorization: `Bearer ${jwtWithInvalidSignature("none")}`,
    code: "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM",
    message: "Unsupported JWT algorithm none",
  },
];

function containerLogs(container: string): Effect.Effect<string, PlatformError, never> {
  return runCommand(["docker", "logs", container]).pipe(
    Effect.map((result) => `${result.stdout}\n${result.stderr}`),
  );
}

const readinessSchedule = Schedule.recurs(240).pipe(
  Schedule.addDelay(() => Effect.succeed(Duration.millis(250))),
);

function waitForLogs(container: string, matches: RegExp): Effect.Effect<string, string> {
  return Effect.gen(function* () {
    const logs = yield* containerLogs(container).pipe(Effect.mapError(String));
    return matches.test(logs) ? logs : yield* Effect.fail("container is not ready");
  }).pipe(Effect.retry(readinessSchedule));
}

function httpGet(url: string, headers?: Readonly<Record<string, string>>) {
  return HttpClient.execute(
    HttpClientRequest.get(url).pipe(
      headers === undefined ? (request) => request : HttpClientRequest.setHeaders(headers),
    ),
  ).pipe(Effect.provide(BunHttpClient.layer));
}

function waitForStatus(url: string, expectedStatus: number) {
  return httpGet(url).pipe(
    Effect.tap((response) => response.text.pipe(Effect.ignore)),
    Effect.filterOrFail(
      (response) => response.status === expectedStatus,
      () => "container is not ready",
    ),
    Effect.retry(readinessSchedule),
  );
}

function writeKongConfig(dir: string, edgeRuntimeContainer: string) {
  // Was: read straight from apps/cli-go/internal/start/templates/kong.yml. That
  // package was deleted outright (CLI-1966; unreachable from the TS CLI, directly
  // or indirectly), so this now uses the TS transcription of the same template
  // that legacy `start`'s Kong service already ports byte-for-byte.
  const config = LEGACY_START_KONG_YML_TEMPLATE.replaceAll(
    "{{ .EdgeRuntimeId }}",
    edgeRuntimeContainer,
  )
    .replaceAll("{{ .BearerToken }}", "$((headers.authorization or headers.apikey))")
    .replaceAll("{{ .QueryToken }}", "$((query_params.apikey))")
    .replace(/{{ \.[A-Za-z]+ }}/g, "unused");
  return writeFileString(join(dir, "kong.yml"), config);
}

describe("functions serve runtime template (offline)", () => {
  test.skipIf(!dockerAvailable)(
    "boots under edge-runtime with networking disabled and fetches nothing remote",
    { timeout: SERVE_OFFLINE_TEST_TIMEOUT_MS },
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtimeImage = yield* Effect.tryPromise({
            try: () => ensureImage(LEGACY_EDGE_RUNTIME_IMAGE),
            catch: (cause) => String(cause),
          });
          const dir = yield* makeTempDirectory("supabase-serve-offline-e2e-");
          const container = `supabase-serve-offline-e2e-${process.pid.toString()}`;
          try {
            yield* writeFileString(join(dir, "index.ts"), yield* bundleServeMainTemplate());

            const run = yield* runCommand("docker", [
              "run",
              "-d",
              "--name",
              container,
              "--network",
              "none",
              "-e",
              "SUPABASE_INTERNAL_HOST_PORT=8081",
              "-e",
              "SUPABASE_INTERNAL_JWT_SECRET=offline-e2e",
              "-e",
              "SUPABASE_URL=http://127.0.0.1:54321",
              "-e",
              "SUPABASE_INTERNAL_FUNCTIONS_CONFIG={}",
              "-e",
              "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=400",
              "-v",
              `${dir}:/app:ro`,
              "--entrypoint",
              "edge-runtime",
              runtimeImage,
              "start",
              "--main-service=/app",
              "--port=8081",
            ]);
            expect(run.status, run.stderr).toBe(0);

            const logs = yield* waitForLogs(container, /Serving functions on|worker boot error/i);

            // The template's own onListen message — proves the bundled worker booted.
            expect(logs).toMatch(/Serving functions on/);
            // No remote module resolution occurred (the #45570 failure mode).
            expect(logs).not.toMatch(/deno\.land|jsr\.io/);
            expect(logs).not.toMatch(/dns error|name resolution|worker boot error/i);
          } finally {
            yield* runCommand("docker", ["rm", "-f", container], { stdio: "ignore" });
            yield* remove(dir);
          }
        }),
      ),
  );

  test.skipIf(!dockerAvailable)(
    "returns canonical JWT auth failures",
    { timeout: SERVE_OFFLINE_TEST_TIMEOUT_MS },
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtimeImage = yield* Effect.tryPromise({
            try: () => ensureImage(LEGACY_EDGE_RUNTIME_IMAGE),
            catch: () => "image unavailable",
          });
          const dir = yield* makeTempDirectory("supabase-serve-auth-e2e-");
          const container = `supabase-serve-auth-e2e-${process.pid.toString()}`;
          try {
            yield* writeFileString(join(dir, "index.ts"), yield* bundleServeMainTemplate());

            const run = yield* runCommand("docker", [
              "run",
              "-d",
              "--name",
              container,
              "-p",
              "127.0.0.1::8081",
              "-e",
              "SUPABASE_INTERNAL_HOST_PORT=8081",
              "-e",
              "SUPABASE_INTERNAL_JWT_SECRET=auth-e2e",
              "-e",
              "SUPABASE_URL=http://127.0.0.1:54321",
              "-e",
              `SUPABASE_INTERNAL_FUNCTIONS_CONFIG=${AUTH_FUNCTIONS_CONFIG}`,
              "-e",
              "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=400",
              "-e",
              'SUPABASE_JWKS={"keys":[]}',
              "-v",
              `${dir}:/app:ro`,
              "--entrypoint",
              "edge-runtime",
              runtimeImage,
              "start",
              "--main-service=/app",
              "--port=8081",
            ]);
            expect(run.status, run.stderr).toBe(0);

            const portResult = yield* runCommand("docker", ["port", container, "8081/tcp"]);
            expect(portResult.status, portResult.stderr).toBe(0);
            const port = Number(portResult.stdout.trim().split(":").at(-1));
            expect(port).toBeGreaterThan(0);
            const url = `http://127.0.0.1:${port}/test`;

            yield* waitForStatus(url, 401).pipe(
              Effect.catch(() =>
                Effect.gen(function* () {
                  return yield* Effect.fail(yield* containerLogs(container));
                }),
              ),
            );

            for (const { name, authorization, code, message } of authFailureCases) {
              const response = yield* httpGet(
                url,
                authorization === undefined ? undefined : { authorization },
              );
              expect(response.status, name).toBe(401);
              expect(response.headers["content-type"], name).toContain("application/json");
              expect(response.headers["sb-error-code"], name).toBe(code);
              expect(yield* response.json, name).toEqual({ code, message, msg: message });
            }

            const logs = yield* containerLogs(container);
            expect(logs).not.toContain("not-a-jwt");
          } finally {
            yield* runCommand("docker", ["rm", "-f", container], { stdio: "ignore" });
            yield* remove(dir);
          }
        }),
      ),
  );

  test.skipIf(!dockerAvailable)(
    "rejects function configs with malformed environment values",
    { timeout: SERVE_OFFLINE_TEST_TIMEOUT_MS },
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtimeImage = yield* Effect.tryPromise({
            try: () => ensureImage(LEGACY_EDGE_RUNTIME_IMAGE),
            catch: () => "image unavailable",
          });
          const dir = yield* makeTempDirectory("supabase-serve-invalid-config-e2e-");
          const container = `supabase-serve-invalid-config-e2e-${process.pid.toString()}`;
          try {
            yield* writeFileString(join(dir, "index.ts"), yield* bundleServeMainTemplate());

            const run = yield* runCommand("docker", [
              "run",
              "-d",
              "--name",
              container,
              "--network",
              "none",
              "-e",
              "SUPABASE_INTERNAL_HOST_PORT=8081",
              "-e",
              "SUPABASE_INTERNAL_JWT_SECRET=invalid-config-e2e",
              "-e",
              "SUPABASE_URL=http://127.0.0.1:54321",
              "-e",
              `SUPABASE_INTERNAL_FUNCTIONS_CONFIG=${MALFORMED_ENV_FUNCTIONS_CONFIG}`,
              "-e",
              "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=400",
              "-v",
              `${dir}:/app:ro`,
              "--entrypoint",
              "edge-runtime",
              runtimeImage,
              "start",
              "--main-service=/app",
              "--port=8081",
            ]);
            expect(run.status, run.stderr).toBe(0);

            const logs = yield* waitForLogs(
              container,
              /Serving functions on|Failed to parse functions config|functions config has an invalid shape/i,
            );
            expect(logs).toMatch(
              /Failed to parse functions config|functions config has an invalid shape/i,
            );
            expect(logs).not.toContain("Serving functions on");
          } finally {
            yield* runCommand("docker", ["rm", "-f", container], { stdio: "ignore" });
            yield* remove(dir);
          }
        }),
      ),
  );

  test.skipIf(!dockerAvailable)(
    "preserves function env and CORS headers and exposes JWT errors through Kong",
    { timeout: SERVE_OFFLINE_TEST_TIMEOUT_MS },
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const imageDeadline = resolveDeadline();
          const [runtimeImage, kongImage] = yield* Effect.all(
            [
              Effect.tryPromise({
                try: () => ensureImage(LEGACY_EDGE_RUNTIME_IMAGE, imageDeadline),
                catch: () => "image unavailable",
              }),
              Effect.tryPromise({
                try: () => ensureImage(dockerfileServiceImage("kong"), imageDeadline),
                catch: () => "image unavailable",
              }),
            ],
            { concurrency: "unbounded" },
          );
          const dir = yield* makeTempDirectory("supabase-serve-kong-e2e-");
          const network = `supabase-serve-kong-e2e-${process.pid.toString()}`;
          const runtimeContainer = `${network}-runtime`;
          const kongContainer = `${network}-kong`;
          try {
            yield* writeFileString(join(dir, "index.ts"), yield* bundleServeMainTemplate());
            yield* makeDirectory(join(dir, "functions", "custom"), true);
            yield* writeFileString(join(dir, "functions", "custom", "index.ts"), CUSTOM_FUNCTION);
            yield* writeFileString(join(dir, "import_map.json"), '{"imports":{}}\n');
            yield* writeKongConfig(dir, runtimeContainer);

            const createNetwork = yield* runCommand("docker", ["network", "create", network]);
            expect(createNetwork.status, createNetwork.stderr).toBe(0);

            const runRuntime = yield* runCommand("docker", [
              "run",
              "-d",
              "--name",
              runtimeContainer,
              "--network",
              network,
              "-e",
              "SUPABASE_INTERNAL_HOST_PORT=8081",
              "-e",
              "SUPABASE_INTERNAL_JWT_SECRET=auth-e2e",
              "-e",
              `SUPABASE_URL=http://${kongContainer}:8000`,
              "-e",
              `SUPABASE_INTERNAL_FUNCTIONS_CONFIG=${KONG_FUNCTIONS_CONFIG}`,
              "-e",
              "SUPABASE_INTERNAL_DEBUG=true",
              "-e",
              "SHARED=shared",
              "-e",
              "GLOBAL_ONLY=global",
              "-e",
              "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=400",
              "-e",
              'SUPABASE_JWKS={"keys":[]}',
              "-v",
              `${dir}:/app:ro`,
              "--entrypoint",
              "edge-runtime",
              runtimeImage,
              "start",
              "--main-service=/app",
              "--port=8081",
            ]);
            expect(runRuntime.status, runRuntime.stderr).toBe(0);

            const runKong = yield* runCommand("docker", [
              "run",
              "-d",
              "--name",
              kongContainer,
              "--network",
              network,
              "-p",
              "127.0.0.1::8000",
              "-e",
              "KONG_DATABASE=off",
              "-e",
              "KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml",
              "-e",
              "KONG_PLUGINS=request-transformer,cors",
              "-e",
              "KONG_NGINX_WORKER_PROCESSES=1",
              "-v",
              `${join(dir, "kong.yml")}:/home/kong/kong.yml:ro`,
              kongImage,
              "kong",
              "docker-start",
            ]);
            expect(runKong.status, runKong.stderr).toBe(0);

            const portResult = yield* runCommand("docker", ["port", kongContainer, "8000/tcp"]);
            expect(portResult.status, portResult.stderr).toBe(0);
            const port = Number(portResult.stdout.trim().split(":").at(-1));
            expect(port).toBeGreaterThan(0);
            const functionsUrl = `http://127.0.0.1:${port}/functions/v1`;
            const authUrl = `${functionsUrl}/test`;

            yield* waitForStatus(authUrl, 401).pipe(
              Effect.catch(() =>
                Effect.gen(function* () {
                  const [kongLogs, runtimeLogs] = yield* Effect.all([
                    containerLogs(kongContainer),
                    containerLogs(runtimeContainer),
                  ]);
                  return yield* Effect.fail(`${kongLogs}\n${runtimeLogs}`);
                }),
              ),
            );

            const customResponse = yield* httpGet(`${functionsUrl}/custom`, {
              origin: "http://localhost:3000",
            });
            expect(customResponse.status).toBe(200);
            expect(customResponse.headers["x-custom-id"]).toBe("abc123");
            expect(customResponse.headers["x-shared"]).toBe("function");
            expect(customResponse.headers["x-function-only"]).toBe("function");
            expect(customResponse.headers["x-global-only"]).toBe("global");
            expect(customResponse.headers["access-control-expose-headers"]?.toLowerCase()).toBe(
              "x-custom-id",
            );
            const runtimeLogs = yield* containerLogs(runtimeContainer);
            expect(runtimeLogs).toContain("Functions config:");
            expect(runtimeLogs).toContain('"custom"');
            expect(runtimeLogs).not.toContain('"env"');
            expect(runtimeLogs).not.toContain("must-not-appear-in-debug-logs");

            const authResponse = yield* httpGet(authUrl, {
              origin: "http://localhost:3000",
            });
            expect(authResponse.status).toBe(401);
            expect(authResponse.headers["sb-error-code"]).toBe("UNAUTHORIZED_NO_AUTH_HEADER");
            expect(authResponse.headers["access-control-expose-headers"]).toBe("sb-error-code");
            expect(yield* authResponse.json).toEqual({
              code: "UNAUTHORIZED_NO_AUTH_HEADER",
              message: "Missing authorization header",
              msg: "Missing authorization header",
            });
          } finally {
            yield* runCommand("docker", ["rm", "-f", kongContainer, runtimeContainer], {
              stdio: "ignore",
            });
            yield* runCommand("docker", ["network", "rm", network], { stdio: "ignore" });
            yield* remove(dir);
          }
        }),
      ),
  );
});
