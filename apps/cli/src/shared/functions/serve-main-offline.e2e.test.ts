import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Clock,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Result,
  Schedule,
  Stream,
} from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/unstable/http";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { START_KONG_YML_TEMPLATE } from "../../commands/start/templates/kong.yml.ts";
import { edgeRuntimeDockerfileImage } from "../../command-internal/edge-runtime-image.ts";
import { ensureImage, resolveDeadline } from "../../../tests/helpers/docker-image.ts";
import { dockerfileServiceImage } from "../services/dockerfile-images.ts";
import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

/**
 * Regression guard for supabase/supabase#45570: the edge-runtime worker
 * bootstrap template must boot with no network access. Before bundling, the
 * template imported `deno.land/std` and `jsr:` modules resolved over the
 * network on every start, so `functions serve` failed offline.
 *
 * Boots the real bundled template with `--network none` and asserts it
 * reaches the "Serving functions" log line without any remote fetch. Mounted
 * at `/app` (read-only) so `/root` stays writable for Deno's module cache —
 * isolating the network as the only variable.
 */

class ServeOfflineE2eError extends Data.TaggedError("ServeOfflineE2eError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const docker = (args: ReadonlyArray<string>, timeoutMs?: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
    );
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        child.exitCode,
        Stream.mkString(Stream.decodeText(child.stdout)),
        Stream.mkString(Stream.decodeText(child.stderr)),
      ],
      { concurrency: "unbounded" },
    );
    return { status: Number(exitCode), stdout, stderr };
  }).pipe(
    Effect.scoped,
    (effect) => (timeoutMs === undefined ? effect : Effect.timeout(effect, timeoutMs)),
    Effect.mapError(
      (cause) => new ServeOfflineE2eError({ message: `docker ${args.join(" ")} failed`, cause }),
    ),
  );

const dockerAvailable = await Effect.runPromise(
  docker(["info"]).pipe(
    Effect.map(({ status }) => status === 0),
    Effect.orElseSucceed(() => false),
    Effect.provide(BunServices.layer),
  ),
);
const SERVE_OFFLINE_STARTUP_TIMEOUT_MS = 60_000;
const SERVE_OFFLINE_ATTEMPT_TIMEOUT_MS = 10_000;
const DOCKER_COMMAND_TIMEOUT_MS = 5_000;
// Cold-cache image resolution (up to a shared 90s budget) runs ahead of the
// 60s startup wait; the test timeout must cover both stacked.
const SERVE_OFFLINE_TEST_TIMEOUT_MS = 180_000;
const AUTH_FUNCTIONS_CONFIG = JSON.stringify({
  test: {
    entrypointPath: "/tmp/test/index.ts",
    importMapPath: "",
    staticFiles: [],
    verifyJWT: true,
  },
});
const KONG_FUNCTIONS_CONFIG = JSON.stringify({
  test: {
    entrypointPath: "/app/functions/custom/index.ts",
    importMapPath: "",
    staticFiles: [],
    verifyJWT: true,
  },
  custom: {
    entrypointPath: "/app/functions/custom/index.ts",
    importMapPath: "",
    staticFiles: [],
    verifyJWT: false,
    env: {
      SHARED: "function",
      FUNCTION_ONLY: "function",
      FUNCTION_SECRET: "must-not-appear-in-debug-logs",
    },
  },
  "custom-alias": {
    entrypointPath: "/app/functions/custom/index.ts",
    importMapPath: "",
    staticFiles: [],
    verifyJWT: false,
  },
  "nested-worker-path": {
    entrypointPath: "/app/functions/custom/.supabase-worker/custom/index.ts",
    importMapPath: "",
    staticFiles: [],
    verifyJWT: false,
  },
});
const CUSTOM_FUNCTION = `import { sharedValue } from "../_shared/value.ts";

Deno.serve((req) => {
  if (req.headers.get("x-reject-before-body") === "true") {
    return new Response("rejected", { status: 400 });
  }
  return new Response("ok", {
    headers: {
      "X-Custom-Id": "abc123",
      "X-Function-Slug": Deno.env.get("SUPABASE_FUNCTION_SLUG") ?? "",
      "X-Shared-Import": sharedValue,
      "X-Shared": Deno.env.get("SHARED") ?? "",
      "X-Function-Only": Deno.env.get("FUNCTION_ONLY") ?? "",
      "X-Global-Only": Deno.env.get("GLOBAL_ONLY") ?? "",
      "Access-Control-Expose-Headers": "X-Custom-Id",
    },
  });
});`;
const NESTED_FUNCTION = `Deno.serve(() => new Response("ok", {
  headers: {
    "X-Function-Slug": Deno.env.get("SUPABASE_FUNCTION_SLUG") ?? "",
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
    code: "UNAUTHORIZED_JWT",
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

const containerLogs = (container: string) =>
  docker(["logs", container], DOCKER_COMMAND_TIMEOUT_MS).pipe(
    Effect.map(({ stdout, stderr }) => `${stdout}\n${stderr}`),
    Effect.catch((error) =>
      Effect.succeed(`\n\n<docker logs failed: ${String(error.cause ?? error.message)}>`),
    ),
  );

const containerState = (container: string) =>
  docker(
    [
      "inspect",
      "--format",
      '{{.State.Status}}{{if ne .State.Status "running"}} (exit code {{.State.ExitCode}}{{if .State.OOMKilled}}, OOM-killed{{end}}){{end}}',
      container,
    ],
    DOCKER_COMMAND_TIMEOUT_MS,
  ).pipe(
    Effect.map(({ status, stdout, stderr }) =>
      status === 0 ? stdout.trim() : `not inspectable (${stderr.trim() || `exit ${status}`})`,
    ),
    Effect.catch((error) =>
      Effect.succeed(`not inspectable (${String(error.cause ?? error.message)})`),
    ),
  );

function isTerminalContainerState(state: string): boolean {
  return /^(exited|dead)\b/u.test(state);
}

const containerDiagnostics = (containers: readonly string[]) =>
  Effect.forEach(
    containers,
    (container) =>
      Effect.all([containerState(container), containerLogs(container)]).pipe(
        Effect.map(([state, logs]) => `${container} (${state}) logs:\n${logs}`),
      ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((blocks) => blocks.join("\n")));

const fetchFunctionWithDiagnostics = (
  request: HttpClientRequest.HttpClientRequest,
  diagnosticContainers: readonly string[],
  timeout: Duration.Input,
) =>
  HttpClient.execute(request).pipe(
    Effect.timeout(timeout),
    Effect.catch((cause) =>
      Effect.gen(function* () {
        return yield* new ServeOfflineE2eError({
          message: `Function request to ${request.url} failed.\n${yield* containerDiagnostics(diagnosticContainers)}`,
          cause,
        });
      }),
    ),
  );

class TransientFunctionResponse extends Data.TaggedError("TransientFunctionResponse")<{
  readonly cause: unknown;
}> {}

class UnexpectedResponseStatus extends Data.TaggedError("UnexpectedResponseStatus")<{
  readonly message: string;
}> {}

const fetchColdFunction = (
  url: string,
  diagnosticContainers: readonly string[],
  headers: Record<string, string> = {},
) => {
  // Runtime health does not start user workers, and Edge Runtime exposes no
  // per-worker readiness signal. A cold worker can briefly disconnect or
  // return 502/503, so retry only those transient outcomes, each bounded so
  // one hung request cannot eat the budget. A container that exited or died
  // ends the wait: nothing will answer.
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + SERVE_OFFLINE_STARTUP_TIMEOUT_MS;
    const attempt = Effect.gen(function* () {
      const attemptMs = Math.min(
        SERVE_OFFLINE_ATTEMPT_TIMEOUT_MS,
        deadline - (yield* Clock.currentTimeMillis),
      );
      const result = yield* HttpClient.execute(HttpClientRequest.get(url, { headers })).pipe(
        Effect.timeout(Duration.millis(Math.max(1, attemptMs))),
        Effect.result,
      );
      if (
        Result.isSuccess(result) &&
        result.success.status !== 502 &&
        result.success.status !== 503
      ) {
        return result.success;
      }
      const cause = Result.isSuccess(result)
        ? new UnexpectedResponseStatus({ message: `Received ${result.success.status} from ${url}` })
        : result.failure;
      if (Result.isSuccess(result)) {
        yield* Stream.runDrain(result.success.stream).pipe(
          Effect.timeout(Duration.millis(Math.max(1, attemptMs))),
          Effect.ignore,
        );
      }
      const states = yield* Effect.forEach(
        diagnosticContainers,
        (container) => Effect.map(containerState(container), (state) => ({ container, state })),
        { concurrency: "unbounded" },
      );
      const dead = states.filter(({ state }) => isTerminalContainerState(state));
      const remainingMs = deadline - (yield* Clock.currentTimeMillis);
      if (dead.length === 0 && remainingMs > 0) {
        return yield* new TransientFunctionResponse({ cause });
      }
      const reason =
        dead.length > 0
          ? `: ${dead.map(({ container, state }) => `${container} is ${state}`).join(", ")}`
          : "";
      return yield* new ServeOfflineE2eError({
        message: `Function at ${url} did not become ready${reason}.\n${yield* containerDiagnostics(diagnosticContainers)}`,
        cause,
      });
    });

    return yield* attempt.pipe(
      Effect.retry({
        schedule: Schedule.spaced("250 millis"),
        while: Predicate.isTagged("TransientFunctionResponse"),
      }),
    );
  });
};

const awaitRuntimeReady = (url: string, diagnosticContainers: readonly string[]) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + SERVE_OFFLINE_STARTUP_TIMEOUT_MS;
    yield* HttpClient.execute(HttpClientRequest.get(url)).pipe(
      Effect.timeout(Duration.millis(SERVE_OFFLINE_ATTEMPT_TIMEOUT_MS)),
      Effect.filterOrFail(
        (response) => response.status === 401,
        (response) =>
          new UnexpectedResponseStatus({ message: `Received ${response.status} from ${url}` }),
      ),
      Effect.retry({
        schedule: Schedule.spaced("250 millis"),
        while: () => Effect.map(Clock.currentTimeMillis, (now) => now < deadline),
      }),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          return yield* new ServeOfflineE2eError({
            message: `Runtime at ${url} did not become ready.\n${yield* containerDiagnostics(diagnosticContainers)}`,
            cause,
          });
        }),
      ),
    );
  });

const writeKongConfig = Effect.fnUntraced(function* (dir: string, edgeRuntimeContainer: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Uses the TS transcription of the Kong template that `start`'s Kong
  // service already ports byte-for-byte.
  const config = START_KONG_YML_TEMPLATE.replaceAll("{{ .EdgeRuntimeId }}", edgeRuntimeContainer)
    .replaceAll("{{ .BearerToken }}", "$((headers.authorization or headers.apikey))")
    .replaceAll("{{ .QueryToken }}", "$((query_params.apikey))")
    .replace(/{{ \.[A-Za-z]+ }}/g, "unused");
  yield* fs.writeFileString(path.join(dir, "kong.yml"), config);
});

const resolveImage = (image: string, deadline?: number) =>
  Effect.tryPromise({
    try: () => ensureImage(image, deadline),
    catch: (cause) =>
      new ServeOfflineE2eError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const removeOnClose = (containers: ReadonlyArray<string>, network?: string) =>
  Effect.addFinalizer(() =>
    docker(["rm", "-f", ...containers]).pipe(
      Effect.andThen(network === undefined ? Effect.void : docker(["network", "rm", network])),
      Effect.ignore,
    ),
  );

const publishedPort = Effect.fnUntraced(function* (container: string, containerPort: string) {
  const portResult = yield* docker(["port", container, containerPort]);
  expect(portResult.status, portResult.stderr).toBe(0);
  const port = Number(portResult.stdout.trim().split(":").at(-1));
  expect(port).toBeGreaterThan(0);
  return port;
});

const testLayer = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);

describe("functions serve runtime template (offline)", () => {
  it.live.skipIf(!dockerAvailable)(
    "boots under edge-runtime with networking disabled and fetches nothing remote",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runtimeImage = yield* resolveImage(yield* edgeRuntimeDockerfileImage);
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-serve-offline-e2e-" });
        const container = `supabase-serve-offline-e2e-${process.pid.toString()}`;
        yield* removeOnClose([container]);
        yield* fs.writeFileString(path.join(dir, "index.ts"), yield* bundleServeMainTemplate());

        const run = yield* docker([
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

        const deadline = (yield* Clock.currentTimeMillis) + SERVE_OFFLINE_STARTUP_TIMEOUT_MS;
        const logs = yield* containerLogs(container).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("250 millis"),
            until: (current) =>
              /Serving functions on/.test(current) || /worker boot error/i.test(current)
                ? Effect.succeed(true)
                : Effect.map(Clock.currentTimeMillis, (now) => now >= deadline),
          }),
        );

        expect(logs).toMatch(/Serving functions on/);
        expect(logs).not.toMatch(/deno\.land|jsr\.io/);
        expect(logs).not.toMatch(/dns error|name resolution|worker boot error/i);
      }).pipe(Effect.provide(testLayer)),
    SERVE_OFFLINE_TEST_TIMEOUT_MS,
  );

  it.live.skipIf(!dockerAvailable)(
    "returns canonical JWT auth failures",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runtimeImage = yield* resolveImage(yield* edgeRuntimeDockerfileImage);
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-serve-auth-e2e-" });
        const container = `supabase-serve-auth-e2e-${process.pid.toString()}`;
        yield* removeOnClose([container]);
        yield* fs.writeFileString(path.join(dir, "index.ts"), yield* bundleServeMainTemplate());

        const run = yield* docker([
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

        const port = yield* publishedPort(container, "8081/tcp");
        const url = `http://127.0.0.1:${port}/test`;

        yield* awaitRuntimeReady(url, [container]);

        for (const { name, authorization, code, message } of authFailureCases) {
          const response = yield* HttpClient.execute(
            HttpClientRequest.get(url, {
              headers: authorization === undefined ? {} : { authorization },
            }),
          );
          expect(response.status, name).toBe(401);
          expect(response.headers["content-type"], name).toContain("application/json");
          expect(response.headers["sb-error-code"], name).toBe(code);
          expect(yield* response.json, name).toEqual({ code, message, msg: message });
        }
      }).pipe(Effect.provide(testLayer)),
    SERVE_OFFLINE_TEST_TIMEOUT_MS,
  );

  it.live.skipIf(!dockerAvailable)(
    "preserves function env and CORS headers, exposes JWT errors, and returns early responses through Kong",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const imageDeadline = resolveDeadline();
        const [runtimeImage, kongImage] = yield* Effect.all(
          [
            resolveImage(yield* edgeRuntimeDockerfileImage, imageDeadline),
            resolveImage(dockerfileServiceImage("kong", false), imageDeadline),
          ],
          { concurrency: "unbounded" },
        );
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-serve-kong-e2e-" });
        const network = `supabase-serve-kong-e2e-${process.pid.toString()}`;
        const runtimeContainer = `${network}-runtime`;
        const kongContainer = `${network}-kong`;
        yield* removeOnClose([kongContainer, runtimeContainer], network);
        yield* fs.writeFileString(path.join(dir, "index.ts"), yield* bundleServeMainTemplate());
        yield* fs.makeDirectory(path.join(dir, "functions", "custom"), { recursive: true });
        yield* fs.makeDirectory(path.join(dir, "functions", "_shared"), { recursive: true });
        yield* fs.makeDirectory(
          path.join(dir, "functions", "custom", ".supabase-worker", "custom"),
          {
            recursive: true,
          },
        );
        yield* fs.writeFileString(
          path.join(dir, "functions", "custom", "index.ts"),
          CUSTOM_FUNCTION,
        );
        yield* fs.writeFileString(
          path.join(dir, "functions", "custom", ".supabase-worker", "custom", "index.ts"),
          NESTED_FUNCTION,
        );
        yield* fs.writeFileString(
          path.join(dir, "functions", "_shared", "value.ts"),
          'export const sharedValue = "shared-import-ok";\n',
        );
        yield* writeKongConfig(dir, runtimeContainer);

        const createNetwork = yield* docker(["network", "create", network]);
        expect(createNetwork.status, createNetwork.stderr).toBe(0);

        const runRuntime = yield* docker([
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

        const runKong = yield* docker([
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
          `${path.join(dir, "kong.yml")}:/home/kong/kong.yml:ro`,
          kongImage,
          "kong",
          "docker-start",
        ]);
        expect(runKong.status, runKong.stderr).toBe(0);

        const port = yield* publishedPort(kongContainer, "8000/tcp");
        const functionsUrl = `http://127.0.0.1:${port}/functions/v1`;
        const authUrl = `${functionsUrl}/test`;

        const diagnosticContainers = [kongContainer, runtimeContainer] as const;
        yield* awaitRuntimeReady(authUrl, diagnosticContainers);

        const [customResponse, aliasResponse, nestedResponse] = yield* Effect.all(
          [
            fetchColdFunction(`${functionsUrl}/custom`, diagnosticContainers, {
              Origin: "http://localhost:3000",
            }),
            fetchColdFunction(`${functionsUrl}/custom-alias`, diagnosticContainers),
            fetchColdFunction(`${functionsUrl}/nested-worker-path`, diagnosticContainers),
          ],
          { concurrency: "unbounded" },
        );
        expect(customResponse.status).toBe(200);
        expect(customResponse.headers["x-custom-id"]).toBe("abc123");
        expect(customResponse.headers["x-function-slug"]).toBe("custom");
        expect(customResponse.headers["x-shared-import"]).toBe("shared-import-ok");
        expect(customResponse.headers["x-shared"]).toBe("function");
        expect(customResponse.headers["x-function-only"]).toBe("function");
        expect(customResponse.headers["x-global-only"]).toBe("global");
        expect(customResponse.headers["access-control-expose-headers"]?.toLowerCase()).toBe(
          "x-custom-id",
        );
        expect(aliasResponse.status).toBe(200);
        expect(aliasResponse.headers["x-function-slug"]).toBe("custom-alias");
        expect(aliasResponse.headers["x-shared-import"]).toBe("shared-import-ok");
        expect(nestedResponse.status).toBe(200);
        expect(nestedResponse.headers["x-function-slug"]).toBe("nested-worker-path");
        const earlyResponse = yield* fetchFunctionWithDiagnostics(
          HttpClientRequest.post(`${functionsUrl}/custom`, {
            headers: { "x-reject-before-body": "true" },
            body: HttpBody.raw(new Uint8Array(1024 * 1024)),
          }),
          diagnosticContainers,
          Duration.seconds(5),
        );
        expect(earlyResponse.status).toBe(400);
        expect(yield* earlyResponse.text.pipe(Effect.timeout(Duration.seconds(5)))).toBe(
          "rejected",
        );
        const runtimeLogs = yield* containerLogs(runtimeContainer);
        expect(runtimeLogs).toContain("Functions config:");
        expect(runtimeLogs).toContain('"custom"');
        expect(runtimeLogs).not.toContain('"env"');
        expect(runtimeLogs).not.toContain("must-not-appear-in-debug-logs");

        const authResponse = yield* HttpClient.execute(
          HttpClientRequest.post(authUrl, {
            headers: { Origin: "http://localhost:3000" },
            body: HttpBody.raw(new Uint8Array(1024 * 1024)),
          }),
        ).pipe(Effect.timeout(Duration.seconds(5)));
        expect(authResponse.status).toBe(401);
        expect(authResponse.headers["sb-error-code"]).toBe("UNAUTHORIZED_NO_AUTH_HEADER");
        expect(authResponse.headers["access-control-expose-headers"]).toBe("sb-error-code");
        expect(yield* authResponse.json.pipe(Effect.timeout(Duration.seconds(5)))).toEqual({
          code: "UNAUTHORIZED_NO_AUTH_HEADER",
          message: "Missing authorization header",
          msg: "Missing authorization header",
        });

        const reusedCustomResponse = yield* HttpClient.execute(
          HttpClientRequest.get(`${functionsUrl}/custom`),
        );
        expect(reusedCustomResponse.status).toBe(200);
        expect(reusedCustomResponse.headers["x-function-slug"]).toBe("custom");
      }).pipe(Effect.provide(testLayer)),
    SERVE_OFFLINE_TEST_TIMEOUT_MS,
  );
});
