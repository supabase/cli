import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Sink, Stream, Tracer } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import {
  EXEC_FAILED_STATE,
  EXEC_FAILURE_OUTPUT,
  PROBE_TIMEOUT_OUTPUT,
  inspectedState,
} from "../../../tests/helpers/docker-health.ts";
import { DbConnectError } from "../db-connection.errors.ts";
import { DbConnection, type DbSession, type PgConnInput } from "../db-connection.service.ts";
import {
  HealthCheckTimeoutError,
  awaitDockerHealthSettled,
  healthCheckExecUnavailableWarning,
  waitForHealthyServices,
  waitForPostgresReady,
  type ExecFallbackProbe,
  type HealthCheckPostgrestGateway,
  type WaitForHealthyServicesOptions,
} from "./health-check.ts";

/** Ends a scripted `logs` script, failing the stream after already-emitted chunks — the real "daemon dropped the pipe mid-dump" case. */
const LOG_STREAM_FAILS = Symbol("log stream fails");

/**
 * A spawner that answers `docker container inspect`/`docker logs` calls. `inspectResponse` is
 * called once per `(containerId, callIndex)` pair, so a test can script a container's health
 * across successive polling rounds. `docker logs` calls succeed with whatever `logs` scripts for
 * that container, optionally terminated by {@link LOG_STREAM_FAILS}, and empty output otherwise.
 */
type LogChunks = ReadonlyArray<string | typeof LOG_STREAM_FAILS>;

/** A container's scripted `docker logs` output; a bare array targets stdout. */
type LogScript = LogChunks | { readonly stdout?: LogChunks; readonly stderr?: LogChunks };

const isLogChunks = (script: LogScript): script is LogChunks => Array.isArray(script);

function mockHealthSpawner(
  inspectResponse: (containerId: string, callIndex: number) => string,
  logs: Readonly<Record<string, LogScript>> = {},
  opts: {
    readonly runtime?: "docker" | "podman";
    readonly beforeInspect?: (containerId: string) => Effect.Effect<void>;
    /** Makes every `docker container inspect` exit non-zero, as when the daemon is unreachable. */
    readonly inspectFails?: boolean;
  } = {},
) {
  const counts = new Map<string, number>();
  const encoder = new TextEncoder();
  const spawned: Array<ReadonlyArray<string>> = [];

  const toStream = (chunks: LogChunks) => {
    const emitted = Stream.fromIterable(
      chunks
        .filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
        .map((chunk) => encoder.encode(chunk)),
    );
    return chunks.includes(LOG_STREAM_FAILS)
      ? Stream.concat(
          emitted,
          Stream.fail(
            PlatformError.systemError({
              _tag: "BadResource",
              module: "ChildProcess",
              method: "stdout",
              description: "broken pipe",
            }),
          ),
        )
      : emitted;
  };

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      const binary = command._tag === "StandardCommand" ? command.command : "";
      // Mirrors a host where only one runtime is installed: `spawnContainerCli`
      // tries `docker` first and falls back to `podman` when the spawn fails.
      if (opts.runtime !== undefined && binary !== opts.runtime) {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: `${binary}: command not found`,
        });
      }
      spawned.push(args);

      let stdoutChunks: LogChunks = [];
      let stderrChunks: LogChunks = [];
      let exitCode = 0;
      if (args[0] === "container" && args[1] === "inspect") {
        const containerId = args[2] ?? "";
        if (opts.beforeInspect !== undefined) {
          yield* opts.beforeInspect(containerId);
        }
        const callIndex = counts.get(containerId) ?? 0;
        counts.set(containerId, callIndex + 1);
        if (opts.inspectFails === true) {
          exitCode = 1;
          stderrChunks = ["Cannot connect to the Docker daemon\n"];
        } else {
          stdoutChunks = [inspectResponse(containerId, callIndex)];
        }
      } else if (args[0] === "logs") {
        const script = logs[args[1] ?? ""];
        if (script !== undefined) {
          if (isLogChunks(script)) {
            stdoutChunks = script;
          } else {
            stdoutChunks = script.stdout ?? [];
            stderrChunks = script.stderr ?? [];
          }
        }
      }

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(exitCode));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: toStream(stdoutChunks),
        stderr: toStream(stderrChunks),
        all: Stream.empty,
        exitCode: Deferred.await(exitDeferred),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  return {
    spawner,
    get spawned() {
      return spawned;
    },
  };
}

const runningHealthy = JSON.stringify({
  Status: "running",
  Running: true,
  Health: { Status: "healthy" },
});
const runningStarting = JSON.stringify({
  Status: "running",
  Running: true,
  Health: { Status: "starting" },
});
const notRunning = JSON.stringify({ Status: "exited", Running: false });

/**
 * `waitForHealthyServices` structurally requires `HttpClient.HttpClient` (only exercised on the
 * PostgREST HTTP-HEAD branch); this layer fails loudly if a container-only-health-check test
 * ever calls it unexpectedly.
 */
const unusedHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("HttpClient should not be called for a plain container check")),
);

describe("waitForHealthyServices", () => {
  it.effect("checks containers serially in their start order", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const mock = mockHealthSpawner(
        () => runningHealthy,
        {},
        {
          beforeInspect: (containerId) =>
            containerId === "supabase_storage_proj"
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirst)),
                )
              : Deferred.succeed(secondStarted, undefined),
        },
      );

      const fiber = yield* waitForHealthyServices(
        mock.spawner,
        ["supabase_storage_proj", "supabase_studio_proj"],
        { timeoutSeconds: 1 },
      ).pipe(Effect.provide(unusedHttpClientLayer), Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(firstStarted);
      yield* Effect.yieldNow;
      const secondStartedBeforeRelease = yield* Deferred.isDone(secondStarted);
      yield* Deferred.succeed(releaseFirst, undefined);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(secondStartedBeforeRelease).toBe(false);
      expect(
        mock.spawned
          .filter((args) => args[0] === "container" && args[1] === "inspect")
          .map((args) => args[2]),
      ).toEqual(["supabase_storage_proj", "supabase_studio_proj"]);
    }),
  );

  it.effect(
    "polls on a 1-second backoff until the container reports healthy, without waiting a full timeout",
    () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner((_id, callIndex) =>
          callIndex === 0 ? runningStarting : runningHealthy,
        );

        const fiber = yield* waitForHealthyServices(mock.spawner, ["supabase_kong_proj"], {
          timeoutSeconds: 30,
        }).pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("1 seconds");
        const exit = yield* Fiber.await(fiber);

        expect(Exit.isSuccess(exit)).toBe(true);
        const inspectCalls = mock.spawned.filter(
          (args) => args[0] === "container" && args[1] === "inspect",
        );
        expect(inspectCalls).toHaveLength(2);
      }),
  );

  it.effect(
    "stops probing a container once it becomes healthy, and only reports the still-unhealthy one on timeout",
    () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner((containerId) =>
          containerId === "supabase_kong_proj" ? runningHealthy : notRunning,
        );

        const fiber = yield* waitForHealthyServices(
          mock.spawner,
          ["supabase_kong_proj", "supabase_rest_proj"],
          { timeoutSeconds: 2 },
        ).pipe(Effect.provide(unusedHttpClientLayer), Effect.forkChild({ startImmediately: true }));

        // 2 retries after the initial attempt.
        yield* TestClock.adjust("1 seconds");
        yield* TestClock.adjust("1 seconds");
        const exit = yield* Fiber.await(fiber);

        expect(Exit.isFailure(exit)).toBe(true);

        const kongCalls = mock.spawned.filter(
          (args) =>
            args[0] === "container" && args[1] === "inspect" && args[2] === "supabase_kong_proj",
        );
        const restCalls = mock.spawned.filter(
          (args) =>
            args[0] === "container" && args[1] === "inspect" && args[2] === "supabase_rest_proj",
        );
        expect(kongCalls).toHaveLength(1);
        expect(restCalls).toHaveLength(3);
      }),
  );

  it.effect(
    "fails with HealthCheckTimeoutError carrying only the still-unhealthy container's reason",
    () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => notRunning);

        const fiber = yield* waitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
        }).pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error).toBeInstanceOf(HealthCheckTimeoutError);
        expect(error.unhealthy).toEqual([
          { containerId: "supabase_rest_proj", reason: "container is not running: exited" },
        ]);
        expect(error.message).toBe("supabase_rest_proj container is not running: exited");
      }),
  );

  it.effect("keeps retrying for 30 seconds when the caller passes no timeout", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => runningStarting);

      const fiber = yield* waitForHealthyServices(mock.spawner, ["supabase_kong_proj"]).pipe(
        Effect.provide(unusedHttpClientLayer),
        Effect.forkChild({ startImmediately: true }),
      );

      for (let second = 0; second < 29; second++) {
        yield* TestClock.adjust("1 seconds");
      }
      const pendingAfter29Seconds = fiber.pollUnsafe();
      yield* TestClock.adjust("1 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(pendingAfter29Seconds).toBeUndefined();
      expect(error).toBeInstanceOf(HealthCheckTimeoutError);
      expect(
        mock.spawned.filter((args) => args[0] === "container" && args[1] === "inspect"),
      ).toHaveLength(31);
    }),
  );

  it.effect("dumps container logs to stderr on a genuine timeout", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => notRunning);
      const writes: Array<string> = [];
      const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
      globalThis.process.stderr.write = ((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      }) as typeof globalThis.process.stderr.write;

      try {
        const fiber = yield* waitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
        }).pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("1 seconds");
        yield* Fiber.await(fiber);
      } finally {
        globalThis.process.stderr.write = originalWrite;
      }

      expect(writes.some((chunk) => chunk.includes("supabase_rest_proj container logs:"))).toBe(
        true,
      );
      expect(
        mock.spawned.some((args) => args[0] === "logs" && args[1] === "supabase_rest_proj"),
      ).toBe(true);
    }),
  );

  it.effect(
    "fails with a hung-probe reason once the wall-clock bound passes when the first round never completes",
    () =>
      withSilencedStderr(
        Effect.gen(function* () {
          const mock = mockHealthSpawner(
            () => runningHealthy,
            {},
            { beforeInspect: () => Effect.never },
          );

          const fiber = yield* waitForHealthyServices(mock.spawner, ["supabase_kong_proj"], {
            timeoutSeconds: 1,
          }).pipe(
            Effect.provide(unusedHttpClientLayer),
            Effect.forkChild({ startImmediately: true }),
          );
          for (let second = 0; second < 21; second++) {
            yield* TestClock.adjust("1 seconds");
          }
          const pendingAt21Seconds = fiber.pollUnsafe();
          yield* TestClock.adjust("1 seconds");
          const error = yield* Fiber.join(fiber).pipe(Effect.flip);

          const reason = "container is not ready: readiness probe hung after 22s";
          expect(pendingAt21Seconds).toBeUndefined();
          expect(error).toBeInstanceOf(HealthCheckTimeoutError);
          expect(error.unhealthy).toEqual([{ containerId: "supabase_kong_proj", reason }]);
          expect(error.message).toBe(`supabase_kong_proj ${reason}`);
        }),
      ),
  );

  it.effect(
    "reports the last completed round's reason when a later round hangs past the wall-clock bound",
    () =>
      withSilencedStderr(
        Effect.gen(function* () {
          let inspects = 0;
          const mock = mockHealthSpawner(
            () => runningStarting,
            {},
            { beforeInspect: () => (++inspects > 1 ? Effect.never : Effect.void) },
          );

          const fiber = yield* waitForHealthyServices(mock.spawner, ["supabase_kong_proj"], {
            timeoutSeconds: 1,
          }).pipe(
            Effect.provide(unusedHttpClientLayer),
            Effect.forkChild({ startImmediately: true }),
          );
          for (let second = 0; second < 21; second++) {
            yield* TestClock.adjust("1 seconds");
          }
          const pendingAt21Seconds = fiber.pollUnsafe();
          yield* TestClock.adjust("1 seconds");
          const error = yield* Fiber.join(fiber).pipe(Effect.flip);

          expect(pendingAt21Seconds).toBeUndefined();
          expect(error).toBeInstanceOf(HealthCheckTimeoutError);
          expect(error.unhealthy).toEqual([
            { containerId: "supabase_kong_proj", reason: "container is not ready: starting" },
          ]);
        }),
      ),
  );

  describe("exec format error recovery advice", () => {
    /**
     * The dumped logs are teed to the real `process.stderr`; swallow them so
     * a scenario that scripts a failing container does not spray the reporter.
     */
    function timeoutError(
      mock: ReturnType<typeof mockHealthSpawner>,
      containerIds: ReadonlyArray<string>,
      images?: ReadonlyMap<string, string>,
    ) {
      return Effect.gen(function* () {
        const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
        globalThis.process.stderr.write = (() => true) as typeof globalThis.process.stderr.write;
        const fiber = yield* waitForHealthyServices(mock.spawner, containerIds, {
          timeoutSeconds: 1,
          images,
        }).pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("1 seconds");
        return yield* Fiber.join(fiber).pipe(
          Effect.flip,
          Effect.ensuring(
            Effect.sync(() => {
              globalThis.process.stderr.write = originalWrite;
            }),
          ),
        );
      });
    }

    it.effect("names the exact image to remove when a container cannot execute its image", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => notRunning, {
          supabase_inbucket_proj: ["exec /mailpit: exec format error\n"],
        });

        const error = yield* timeoutError(
          mock,
          ["supabase_inbucket_proj"],
          new Map([["supabase_inbucket_proj", "public.ecr.aws/supabase/mailpit:v1.30.2"]]),
        );

        // Reasons unchanged; the advice rides on `suggestion`, which is what
        // suppresses the unhelpful "--debug" hint downstream.
        expect(error.message).toBe("supabase_inbucket_proj container is not running: exited");
        expect(error.unhealthy).toEqual([
          { containerId: "supabase_inbucket_proj", reason: "container is not running: exited" },
        ]);
        // Container and image named together: they can be named after different
        // things, so either alone leaves the reader guessing.
        expect(error.suggestion).toContain(
          "supabase_inbucket_proj's image public.ecr.aws/supabase/mailpit:v1.30.2",
        );
        // Names the cause without promising a remedy: re-pulling fixes a corrupt
        // or wrong-architecture copy, but not a version with no build at all.
        expect(error.suggestion).toContain("built for a different architecture");
        expect(error.suggestion).toContain(
          "docker image rm -f public.ecr.aws/supabase/mailpit:v1.30.2",
        );
      }),
    );

    it.effect("matches the marker when Docker splits it across log chunks", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => notRunning, {
          supabase_studio_proj: ["exec /docker-entrypoint.sh: exec for", "mat error\n"],
        });

        const error = yield* timeoutError(
          mock,
          ["supabase_studio_proj"],
          new Map([["supabase_studio_proj", "public.ecr.aws/supabase/studio:2026.07.13"]]),
        );

        expect(error.suggestion).toContain(
          "docker image rm -f public.ecr.aws/supabase/studio:2026.07.13",
        );
      }),
    );

    it.effect("keeps a marker already seen when the log stream breaks mid-dump", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => notRunning, {
          supabase_inbucket_proj: ["exec /mailpit: exec format error\n", LOG_STREAM_FAILS],
        });

        const error = yield* timeoutError(
          mock,
          ["supabase_inbucket_proj"],
          new Map([["supabase_inbucket_proj", "public.ecr.aws/supabase/mailpit:v1.30.2"]]),
        );

        expect(error.suggestion).toContain(
          "docker image rm -f public.ecr.aws/supabase/mailpit:v1.30.2",
        );
      }),
    );

    it.effect("stays silent for an ordinary unhealthy container", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => notRunning, {
          supabase_storage_proj: ['{"msg":"Server not started with error"}\n'],
        });

        const error = yield* timeoutError(mock, ["supabase_storage_proj"]);

        expect(error.message).toBe("supabase_storage_proj container is not running: exited");
        expect(error.suggestion).toBeUndefined();
      }),
    );

    it.effect("detects the marker when it arrives on the container's stderr stream", () =>
      Effect.gen(function* () {
        // `docker logs` demuxes the container's stderr onto its own stderr pipe, so this is the
        // real path, not the stdout one every other scenario here scripts.
        const mock = mockHealthSpawner(() => notRunning, {
          supabase_inbucket_proj: { stderr: ["exec /mailpit: exec format error\n"] },
        });

        const error = yield* timeoutError(
          mock,
          ["supabase_inbucket_proj"],
          new Map([["supabase_inbucket_proj", "public.ecr.aws/supabase/mailpit:v1.30.2"]]),
        );

        expect(error.suggestion).toContain(
          "docker image rm -f public.ecr.aws/supabase/mailpit:v1.30.2",
        );
      }),
    );

    it.effect("names podman in the recovery command on a Podman-only host", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(
          () => notRunning,
          { supabase_inbucket_proj: { stderr: ["exec format error\n"] } },
          { runtime: "podman" },
        );

        const error = yield* timeoutError(
          mock,
          ["supabase_inbucket_proj"],
          new Map([["supabase_inbucket_proj", "public.ecr.aws/supabase/mailpit:v1.30.2"]]),
        );

        // A `docker ...` line would be uncopyable on a host without Docker.
        expect(error.suggestion).toContain(
          "podman image rm -f public.ecr.aws/supabase/mailpit:v1.30.2",
        );
        expect(error.suggestion).not.toContain("docker image rm");
      }),
    );

    it.effect("leads the recovery sequence with supabase stop", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => notRunning, {
          supabase_inbucket_proj: ["exec format error\n"],
        });

        const error = yield* timeoutError(
          mock,
          ["supabase_inbucket_proj"],
          new Map([["supabase_inbucket_proj", "public.ecr.aws/supabase/mailpit:v1.30.2"]]),
        );

        // Without `supabase stop`, the `--ignore-health-check` path leaves the
        // stack up and the next `supabase start` short-circuits on
        // already-running, never recreating the broken container.
        const suggestion = error.suggestion ?? "";
        expect(suggestion).toContain("supabase stop");
        expect(suggestion.indexOf("supabase stop")).toBeLessThan(suggestion.indexOf("image rm -f"));
        expect(suggestion.indexOf("image rm -f")).toBeLessThan(
          suggestion.indexOf("supabase start"),
        );
        // Both `supabase` steps resolve their own project, so a run made with
        // `--workdir` has to repeat it rather than rely on the current directory.
        expect(suggestion).toContain("--workdir");
        // And a next step for the cause re-pulling cannot fix.
        expect(suggestion).toContain("no build for this machine's architecture");
      }),
    );

    it.effect("lists every distinct broken image", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => notRunning, {
          supabase_inbucket_proj: ["exec format error\n"],
          supabase_studio_proj: ["exec format error\n"],
        });

        const error = yield* timeoutError(
          mock,
          ["supabase_inbucket_proj", "supabase_studio_proj"],
          new Map([
            ["supabase_inbucket_proj", "public.ecr.aws/supabase/mailpit:v1.30.2"],
            ["supabase_studio_proj", "public.ecr.aws/supabase/studio:2026.07.13"],
          ]),
        );

        expect(error.suggestion).toContain(
          "supabase_inbucket_proj's image public.ecr.aws/supabase/mailpit:v1.30.2",
        );
        expect(error.suggestion).toContain(
          "supabase_studio_proj's image public.ecr.aws/supabase/studio:2026.07.13",
        );
        expect(error.suggestion).toContain(
          "docker image rm -f public.ecr.aws/supabase/mailpit:v1.30.2 public.ecr.aws/supabase/studio:2026.07.13",
        );
      }),
    );

    it.effect("dedupes an image shared by two broken containers", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => notRunning, {
          supabase_rest_proj: ["exec format error\n"],
          supabase_realtime_proj: ["exec format error\n"],
          supabase_storage_proj: ["listening on :5000\n"],
        });

        const error = yield* timeoutError(
          mock,
          ["supabase_rest_proj", "supabase_realtime_proj", "supabase_storage_proj"],
          new Map([
            ["supabase_rest_proj", "public.ecr.aws/supabase/postgrest:v14.15"],
            ["supabase_realtime_proj", "public.ecr.aws/supabase/postgrest:v14.15"],
            ["supabase_storage_proj", "public.ecr.aws/supabase/storage-api:v1.66.4"],
          ]),
        );

        expect(error.suggestion).toContain("supabase_rest_proj's image");
        expect(error.suggestion).toContain("supabase_realtime_proj's image");
        expect(error.suggestion).toContain(
          "docker image rm -f public.ecr.aws/supabase/postgrest:v14.15",
        );
        expect(error.suggestion).not.toContain(
          "postgrest:v14.15 public.ecr.aws/supabase/postgrest:v14.15",
        );
        expect(error.suggestion).not.toContain("storage-api");
      }),
    );
  });

  describe("PostgREST HTTP-HEAD readiness", () => {
    function postgrestGateway(secretKey: string): HealthCheckPostgrestGateway {
      return {
        containerId: "supabase_rest_proj",
        apiExternalUrl: "http://127.0.0.1:54321",
        secretKey,
      };
    }

    function httpLayer(status: number, expectHeaders: (headers: Record<string, string>) => void) {
      return Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          expectHeaders({ ...request.headers });
          expect(request.method).toBe("HEAD");
          expect(request.url).toBe("http://127.0.0.1:54321/rest-admin/v1/ready");
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status })),
          );
        }),
      );
    }

    it.effect("bypasses the Docker healthcheck and succeeds on a 200 HEAD response", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningHealthy);
        const layer = httpLayer(200, (headers) => {
          expect(headers["apikey"]).toBe("sb_secret_local");
          expect(headers["authorization"]).toBeUndefined();
        });

        const exit = yield* waitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
          postgrest: postgrestGateway("sb_secret_local"),
        }).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(mock.spawned.some((args) => args[0] === "container" && args[1] === "inspect")).toBe(
          false,
        );
      }),
    );

    it.effect("sends both apikey and Authorization headers for a JWT secret key", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningHealthy);
        const layer = httpLayer(200, (headers) => {
          expect(headers["apikey"]).toBe("ey.jwt.key");
          expect(headers["authorization"]).toBe("Bearer ey.jwt.key");
        });

        const exit = yield* waitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
          postgrest: postgrestGateway("ey.jwt.key"),
        }).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isSuccess(exit)).toBe(true);
      }),
    );

    it.effect("retries and eventually times out when PostgREST never returns 200", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningHealthy);
        const layer = httpLayer(503, () => {});

        const fiber = yield* waitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
          postgrest: postgrestGateway("sb_secret_local"),
        }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error).toBeInstanceOf(HealthCheckTimeoutError);
        expect(error.unhealthy).toEqual([
          { containerId: "supabase_rest_proj", reason: "unexpected status 503" },
        ]);
      }),
    );

    it.effect("records the probe count on the wait span instead of a span per HTTP probe", () =>
      Effect.gen(function* () {
        const spans: Array<Tracer.NativeSpan> = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const mock = mockHealthSpawner(() => runningHealthy);

        const fiber = yield* waitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
          postgrest: postgrestGateway("sb_secret_local"),
        }).pipe(
          Effect.provide(httpLayer(503, () => {})),
          Effect.withTracer(tracer),
          Effect.withTracerEnabled(true),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("1 seconds");
        yield* Fiber.await(fiber);

        const wait = spans.find((span) => span.name === "HealthCheck.waitHealthyServices");
        expect(spans.map((span) => span.name)).not.toContain("HEAD");
        expect(wait?.attributes.get("retry.attempt_count")).toBe(2);
      }),
    );
  });

  describe("Edge Runtime HTTP-HEAD readiness", () => {
    function edgeRuntimeGateway(secretKey: string): HealthCheckPostgrestGateway {
      return {
        containerId: "supabase_edge_runtime_proj",
        apiExternalUrl: "http://127.0.0.1:54321",
        secretKey,
      };
    }

    function httpLayer(status: number, expectPath: string) {
      return Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          expect(request.method).toBe("HEAD");
          expect(request.url).toBe(`http://127.0.0.1:54321${expectPath}`);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status })),
          );
        }),
      );
    }

    it.effect("bypasses the Docker healthcheck and succeeds on a 200 HEAD response", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningHealthy);
        const layer = httpLayer(200, "/functions/v1/_internal/health");

        const exit = yield* waitForHealthyServices(mock.spawner, ["supabase_edge_runtime_proj"], {
          timeoutSeconds: 1,
          edgeRuntime: edgeRuntimeGateway("sb_secret_local"),
        }).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(mock.spawned.some((args) => args[0] === "container" && args[1] === "inspect")).toBe(
          false,
        );
      }),
    );

    it.effect("retries and eventually times out when Edge Runtime never returns 200", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningHealthy);
        const layer = httpLayer(503, "/functions/v1/_internal/health");

        const fiber = yield* waitForHealthyServices(mock.spawner, ["supabase_edge_runtime_proj"], {
          timeoutSeconds: 1,
          edgeRuntime: edgeRuntimeGateway("sb_secret_local"),
        }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error).toBeInstanceOf(HealthCheckTimeoutError);
        expect(error.unhealthy).toEqual([
          { containerId: "supabase_edge_runtime_proj", reason: "unexpected status 503" },
        ]);
      }),
    );

    it.effect(
      "probes PostgREST and Edge Runtime on their own paths, and every other container via Docker",
      () =>
        Effect.gen(function* () {
          const mock = mockHealthSpawner(() => runningHealthy);
          const layer = Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              const url = new URL(request.url);
              expect(["/rest-admin/v1/ready", "/functions/v1/_internal/health"]).toContain(
                url.pathname,
              );
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
              );
            }),
          );

          const exit = yield* waitForHealthyServices(
            mock.spawner,
            ["supabase_rest_proj", "supabase_edge_runtime_proj", "supabase_kong_proj"],
            {
              timeoutSeconds: 1,
              postgrest: {
                containerId: "supabase_rest_proj",
                apiExternalUrl: "http://127.0.0.1:54321",
                secretKey: "sb_secret_local",
              },
              edgeRuntime: edgeRuntimeGateway("sb_secret_local"),
            },
          ).pipe(Effect.provide(layer), Effect.exit);

          expect(Exit.isSuccess(exit)).toBe(true);
          expect(
            mock.spawned.some(
              (args) =>
                args[0] === "container" &&
                args[1] === "inspect" &&
                args[2] === "supabase_kong_proj",
            ),
          ).toBe(true);
          expect(
            mock.spawned.some(
              (args) =>
                args[0] === "container" &&
                args[1] === "inspect" &&
                args[2] === "supabase_rest_proj",
            ),
          ).toBe(false);
          expect(
            mock.spawned.some(
              (args) =>
                args[0] === "container" &&
                args[1] === "inspect" &&
                args[2] === "supabase_edge_runtime_proj",
            ),
          ).toBe(false);
        }),
    );
  });
});

const SHADOW_CONTAINER_ID = "abc123456789shadow";

const shadowConnConfig: PgConnInput = {
  host: "127.0.0.1",
  port: 54320,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

/**
 * A `DbConnection` whose `connect` fails the first `failTimes` calls, recording every dialled
 * config and how many probe sessions were released. `closedSessions` proves the readiness probe
 * hands nothing back to the caller.
 */
function mockShadowDbConnection(
  opts: { readonly failTimes?: number; readonly connectMillis?: number } = {},
) {
  const failTimes = opts.failTimes ?? 0;
  const session: DbSession = {
    exec: () => Effect.void,
    query: () => Effect.succeed([]),
    execBatch: () => Effect.void,
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  const attempts: Array<PgConnInput> = [];
  let closedSessions = 0;
  const layer = Layer.succeed(DbConnection, {
    connect: (cfg) =>
      Effect.gen(function* () {
        attempts.push(cfg);
        // A dial that hangs before answering — how a real attempt burns its own connect timeout.
        if (opts.connectMillis !== undefined) yield* Effect.sleep(opts.connectMillis);
        if (attempts.length <= failTimes) {
          return yield* new DbConnectError({ message: "connection refused" });
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closedSessions += 1;
          }),
        );
        return session;
      }),
  });
  return {
    layer,
    attempts,
    get closedSessions() {
      return closedSessions;
    },
  };
}

/** The timeout path tees the container's logs to the real stderr — swallow them. */
function withSilencedStderr<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
    globalThis.process.stderr.write = (() => true) as typeof globalThis.process.stderr.write;
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.process.stderr.write = originalWrite;
        }),
      ),
    );
  });
}

const inspectCalls = (mock: ReturnType<typeof mockHealthSpawner>) =>
  mock.spawned.filter((args) => args[0] === "container" && args[1] === "inspect");

describe("waitForPostgresReady", () => {
  it.effect(
    "resolves on the first successful connect, while Docker still reports the healthcheck as starting",
    () =>
      Effect.gen(function* () {
        // The shadow container's healthcheck runs on a 10s interval with no start period, so
        // Docker cannot report `healthy` before t+10s even though Postgres accepts connections
        // at ~3.5s — this wait never consults the health status at all.
        const mock = mockHealthSpawner(() => runningStarting);
        const db = mockShadowDbConnection();

        const exit = yield* waitForPostgresReady(
          mock.spawner,
          SHADOW_CONTAINER_ID,
          shadowConnConfig,
          { timeoutSeconds: 30 },
        ).pipe(Effect.provide(db.layer), Effect.exit);

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(inspectCalls(mock)).toHaveLength(1);
        expect(db.attempts).toHaveLength(1);
        // Bounded, so a hung dial cannot eat a whole poll round's budget.
        expect(db.attempts[0]?.connectTimeoutSeconds).toBe(2);
        // Released immediately: the caller opens its own connection afterwards.
        expect(db.closedSessions).toBe(1);
      }),
  );

  it.effect("keeps polling a refused connect on a 500ms backoff until it succeeds", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => runningStarting);
      const db = mockShadowDbConnection({ failTimes: 2 });

      const fiber = yield* waitForPostgresReady(
        mock.spawner,
        SHADOW_CONTAINER_ID,
        shadowConnConfig,
        {
          timeoutSeconds: 30,
        },
      ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("1 seconds");
      yield* TestClock.adjust("1 seconds");
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isSuccess(exit)).toBe(true);
      // A refused connect is "not ready yet", never an error in its own right.
      expect(db.attempts).toHaveLength(3);
      expect(inspectCalls(mock)).toHaveLength(3);
      expect(db.closedSessions).toBe(1);
    }),
  );

  it.effect(
    "fails with HealthCheckTimeoutError and dumps the container's logs when it never becomes connectable",
    () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningStarting);
        const db = mockShadowDbConnection({ failTimes: Number.POSITIVE_INFINITY });

        const error = yield* withSilencedStderr(
          Effect.gen(function* () {
            const fiber = yield* waitForPostgresReady(
              mock.spawner,
              SHADOW_CONTAINER_ID,
              shadowConnConfig,
              { timeoutSeconds: 2 },
            ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

            yield* TestClock.adjust("1 seconds");
            yield* TestClock.adjust("1 seconds");
            return yield* Fiber.join(fiber).pipe(Effect.flip);
          }),
        );

        expect(error).toBeInstanceOf(HealthCheckTimeoutError);
        expect(error.unhealthy).toEqual([
          {
            containerId: SHADOW_CONTAINER_ID,
            reason: "container is not ready: connection refused",
          },
        ]);
        expect(error.message).toBe(
          `${SHADOW_CONTAINER_ID} container is not ready: connection refused`,
        );
        // 1 initial attempt plus `timeoutSeconds * 2` retries at 500ms intervals.
        expect(db.attempts).toHaveLength(5);
        expect(
          mock.spawned.some((args) => args[0] === "logs" && args[1] === SHADOW_CONTAINER_ID),
        ).toBe(true);
      }),
  );

  it.effect("stops on elapsed time, not on the retry count, when every attempt hangs", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => runningStarting);
      // 1.2s per dial plus 500ms spacing — the retry count alone would keep polling past the wall cap.
      const db = mockShadowDbConnection({
        failTimes: Number.POSITIVE_INFINITY,
        connectMillis: 1200,
      });

      const error = yield* withSilencedStderr(
        Effect.gen(function* () {
          const fiber = yield* waitForPostgresReady(
            mock.spawner,
            SHADOW_CONTAINER_ID,
            shadowConnConfig,
            { timeoutSeconds: 3 },
          ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

          // The whole wait's wall-clock cap: `timeoutSeconds` of backoff plus one dial's
          // 2-second connect allowance. Joining here would hang if the wait were still counting
          // rounds instead of seconds.
          yield* TestClock.adjust("5 seconds");
          return yield* Fiber.join(fiber).pipe(Effect.flip);
        }),
      );

      // Cut off mid-way through the third dial — the 4-attempt retry budget never ran out.
      expect(db.attempts).toHaveLength(3);
      // Same failure the exhausted path produces: the last completed attempt's own reason,
      // the same `<id> <reason>` message, and the same log dump.
      expect(error).toBeInstanceOf(HealthCheckTimeoutError);
      expect(error.message).toBe(
        `${SHADOW_CONTAINER_ID} container is not ready: connection refused`,
      );
      expect(error.unhealthy).toEqual([
        { containerId: SHADOW_CONTAINER_ID, reason: "container is not ready: connection refused" },
      ]);
      expect(
        mock.spawned.some((args) => args[0] === "logs" && args[1] === SHADOW_CONTAINER_ID),
      ).toBe(true);
    }),
  );

  it.effect("fails fast, well inside the budget, once the container has exited", () =>
    Effect.gen(function* () {
      // Running on the first round, gone on every round after it.
      const mock = mockHealthSpawner((_id, callIndex) =>
        callIndex === 0 ? runningStarting : notRunning,
      );
      const db = mockShadowDbConnection({ failTimes: Number.POSITIVE_INFINITY });

      const error = yield* withSilencedStderr(
        Effect.gen(function* () {
          const fiber = yield* waitForPostgresReady(
            mock.spawner,
            SHADOW_CONTAINER_ID,
            shadowConnConfig,
            { timeoutSeconds: 30 },
          ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

          yield* TestClock.adjust("1 seconds");
          return yield* Fiber.join(fiber).pipe(Effect.flip);
        }),
      );

      expect(error).toBeInstanceOf(HealthCheckTimeoutError);
      expect(error.unhealthy).toEqual([
        { containerId: SHADOW_CONTAINER_ID, reason: "container is not running: exited" },
      ]);
      // A dead container can never become connectable — fails on the next poll, not at 30s.
      expect(inspectCalls(mock)).toHaveLength(2);
      expect(db.attempts).toHaveLength(1);
      expect(
        mock.spawned.some((args) => args[0] === "logs" && args[1] === SHADOW_CONTAINER_ID),
      ).toBe(true);
    }),
  );

  it.effect("reports a first dial that never returns as not ready, naming the wall-clock cap", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => runningStarting);
      const db = mockShadowDbConnection({
        failTimes: Number.POSITIVE_INFINITY,
        connectMillis: 60_000,
      });

      const error = yield* withSilencedStderr(
        Effect.gen(function* () {
          const fiber = yield* waitForPostgresReady(
            mock.spawner,
            SHADOW_CONTAINER_ID,
            shadowConnConfig,
            { timeoutSeconds: 1 },
          ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

          yield* TestClock.adjust("3 seconds");
          return yield* Fiber.join(fiber).pipe(Effect.flip);
        }),
      );

      const reason = "container is not ready: connection attempt hung after 3s";
      expect(error).toBeInstanceOf(HealthCheckTimeoutError);
      expect(error.message).toBe(`${SHADOW_CONTAINER_ID} ${reason}`);
      expect(error.unhealthy).toEqual([{ containerId: SHADOW_CONTAINER_ID, reason }]);
      expect(db.attempts).toHaveLength(1);
    }),
  );

  describe("exec format error recovery advice", () => {
    it.effect("names the shadow's image when its dumped logs show exec format error", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningStarting, {
          [SHADOW_CONTAINER_ID]: ["exec /docker-entrypoint.sh: exec format error\n"],
        });
        const db = mockShadowDbConnection({ failTimes: Number.POSITIVE_INFINITY });

        const error = yield* withSilencedStderr(
          Effect.gen(function* () {
            const fiber = yield* waitForPostgresReady(
              mock.spawner,
              SHADOW_CONTAINER_ID,
              shadowConnConfig,
              { timeoutSeconds: 1, image: "public.ecr.aws/supabase/postgres:15.1.0.147" },
            ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

            yield* TestClock.adjust("1 seconds");
            return yield* Fiber.join(fiber).pipe(Effect.flip);
          }),
        );

        expect(error).toBeInstanceOf(HealthCheckTimeoutError);
        expect(error.suggestion).toContain(
          `${SHADOW_CONTAINER_ID}'s image public.ecr.aws/supabase/postgres:15.1.0.147`,
        );
        expect(error.suggestion).toContain(
          "supabase stop\n  docker image rm -f public.ecr.aws/supabase/postgres:15.1.0.147\n  supabase start",
        );
      }),
    );

    it.effect("stays silent when no image is named, even if the logs show exec format error", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningStarting, {
          [SHADOW_CONTAINER_ID]: ["exec /docker-entrypoint.sh: exec format error\n"],
        });
        const db = mockShadowDbConnection({ failTimes: Number.POSITIVE_INFINITY });

        const error = yield* withSilencedStderr(
          Effect.gen(function* () {
            const fiber = yield* waitForPostgresReady(
              mock.spawner,
              SHADOW_CONTAINER_ID,
              shadowConnConfig,
              { timeoutSeconds: 1 },
            ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

            yield* TestClock.adjust("1 seconds");
            return yield* Fiber.join(fiber).pipe(Effect.flip);
          }),
        );

        expect(error).toBeInstanceOf(HealthCheckTimeoutError);
        expect(error.suggestion).toBeUndefined();
      }),
    );

    it.effect("stays silent for a plain not-ready timeout even when an image is named", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningStarting);
        const db = mockShadowDbConnection({ failTimes: Number.POSITIVE_INFINITY });

        const error = yield* withSilencedStderr(
          Effect.gen(function* () {
            const fiber = yield* waitForPostgresReady(
              mock.spawner,
              SHADOW_CONTAINER_ID,
              shadowConnConfig,
              { timeoutSeconds: 1, image: "public.ecr.aws/supabase/postgres:15.1.0.147" },
            ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

            yield* TestClock.adjust("1 seconds");
            return yield* Fiber.join(fiber).pipe(Effect.flip);
          }),
        );

        expect(error).toBeInstanceOf(HealthCheckTimeoutError);
        expect(error.suggestion).toBeUndefined();
      }),
    );
  });
});

describe("waitForHealthyServices where Docker cannot exec health checks", () => {
  const STUDIO = "supabase_studio_proj";
  const STORAGE = "supabase_storage_proj";
  const GATEWAY_URL = "http://127.0.0.1:54321";
  const STORAGE_STATUS_PATH = "/storage/v1/status";

  const orderlyUnhealthy = inspectedState({
    health: "unhealthy",
    probes: [{ exitCode: 1, output: "pg_isready: no response" }],
  });
  const probeTimedOut = inspectedState({
    health: "unhealthy",
    probes: [{ exitCode: -1, output: PROBE_TIMEOUT_OUTPUT }],
  });

  const runningFallback = (...containerIds: ReadonlyArray<string>) =>
    new Map<string, ExecFallbackProbe>(containerIds.map((id) => [id, { kind: "running" }]));
  const gatewayFallback = (containerId: string, path: string) =>
    new Map<string, ExecFallbackProbe>([
      [
        containerId,
        {
          kind: "gateway",
          gateway: { apiExternalUrl: GATEWAY_URL, secretKey: "sb_secret_local" },
          path,
        },
      ],
    ]);

  const KONG = "supabase_kong_proj";
  const reachableFallback = (containerId: string) =>
    new Map<string, ExecFallbackProbe>([
      [
        containerId,
        {
          kind: "gateway-reachable",
          gateway: { apiExternalUrl: GATEWAY_URL, secretKey: "sb_secret_local" },
        },
      ],
    ]);

  function recordingGateway(statusByPath: Readonly<Record<string, number>> = {}) {
    const requests: Array<{
      readonly method: string;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }> = [];
    const layer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push({
          method: request.method,
          url: request.url,
          headers: { ...request.headers },
        });
        const status = statusByPath[new URL(request.url).pathname] ?? 200;
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status })));
      }),
    );
    return { layer, requests };
  }

  const settled = (
    mock: ReturnType<typeof mockHealthSpawner>,
    containerIds: ReadonlyArray<string>,
    opts: WaitForHealthyServicesOptions = {},
    http: Layer.Layer<HttpClient.HttpClient> = unusedHttpClientLayer,
  ) =>
    waitForHealthyServices(mock.spawner, containerIds, { timeoutSeconds: 1, ...opts }).pipe(
      Effect.provide(http),
    );

  const timeoutFailure = (
    mock: ReturnType<typeof mockHealthSpawner>,
    containerIds: ReadonlyArray<string>,
    opts: WaitForHealthyServicesOptions = {},
    http: Layer.Layer<HttpClient.HttpClient> = unusedHttpClientLayer,
  ) =>
    withSilencedStderr(
      Effect.gen(function* () {
        const fiber = yield* settled(mock, containerIds, opts, http).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("1 seconds");
        return yield* Fiber.join(fiber).pipe(Effect.flip);
      }),
    );

  it.effect("names the probe's OCI error and the exec check when no fallback is configured", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => EXEC_FAILED_STATE);

      const error = yield* timeoutFailure(mock, [STUDIO]);

      const reason = `container is not ready: unhealthy (last health check exit code -1: ${EXEC_FAILURE_OUTPUT})`;
      expect(error).toBeInstanceOf(HealthCheckTimeoutError);
      expect(error.unhealthy).toEqual([{ containerId: STUDIO, reason }]);
      expect(error.message).toBe(`${STUDIO} ${reason}`);
      expect(error.suggestion).toBe(
        [
          `Docker could not run the health check inside ${STUDIO} ("OCI runtime exec failed"), so it cannot report them healthy.`,
          "This happens when Docker runs nested or sandboxed.",
          `Check with: docker exec ${STUDIO} true`,
        ].join("\n"),
      );
    }),
  );

  it.effect("names an ordinary failing probe without the exec-unavailable suggestion", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => orderlyUnhealthy);

      const error = yield* timeoutFailure(mock, [STUDIO]);

      expect(error.message).toBe(
        `${STUDIO} container is not ready: unhealthy (last health check exit code 1: pg_isready: no response)`,
      );
      expect(error.suggestion).toBeUndefined();
    }),
  );

  it.effect("still fails a probe timeout (exit -1) when a running fallback is configured", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => probeTimedOut);

      const error = yield* timeoutFailure(mock, [STUDIO], {
        execFallbacks: runningFallback(STUDIO),
      });

      expect(error.message).toBe(
        `${STUDIO} container is not ready: unhealthy (last health check exit code -1: Health check exceeded timeout (2s))`,
      );
      expect(error.suggestion).toBeUndefined();
    }),
  );

  it.effect("still fails a restarting container whose last probe was an exec failure", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() =>
        inspectedState({
          status: "restarting",
          health: "unhealthy",
          probes: [{ exitCode: -1, output: EXEC_FAILURE_OUTPUT }],
        }),
      );

      const error = yield* timeoutFailure(mock, [STUDIO], {
        execFallbacks: runningFallback(STUDIO),
      });

      expect(error.message).toContain(`${STUDIO} container is not ready: unhealthy (last health`);
      expect(error.suggestion).toBeUndefined();
    }),
  );

  it.effect(
    "accepts an exec-failed container on a running fallback and reports it as assumed",
    () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => EXEC_FAILED_STATE);

        const result = yield* settled(mock, [STUDIO], { execFallbacks: runningFallback(STUDIO) });

        expect(result).toEqual({ execUnavailable: [STUDIO], readinessAssumed: [STUDIO] });
      }),
  );

  it.effect("verifies an exec-failed container through the gateway with an authenticated GET", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => EXEC_FAILED_STATE);
      const gateway = recordingGateway();

      const result = yield* settled(
        mock,
        [STORAGE],
        { execFallbacks: gatewayFallback(STORAGE, STORAGE_STATUS_PATH) },
        gateway.layer,
      );

      expect(result).toEqual({ execUnavailable: [STORAGE], readinessAssumed: [] });
      expect(gateway.requests).toEqual([
        {
          method: "GET",
          url: `${GATEWAY_URL}${STORAGE_STATUS_PATH}`,
          headers: expect.objectContaining({ apikey: "sb_secret_local" }),
        },
      ]);
    }),
  );

  for (const status of [503, 404]) {
    it.effect(`fails with the gateway's ${status} and the exec suggestion when it is not 200`, () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => EXEC_FAILED_STATE);
        const gateway = recordingGateway({ [STORAGE_STATUS_PATH]: status });

        const error = yield* timeoutFailure(
          mock,
          [STORAGE],
          { execFallbacks: gatewayFallback(STORAGE, STORAGE_STATUS_PATH) },
          gateway.layer,
        );

        expect(error.unhealthy).toEqual([
          {
            containerId: STORAGE,
            reason: `container is not ready: ${STORAGE_STATUS_PATH}: unexpected status ${status}`,
          },
        ]);
        expect(error.suggestion).toContain(`Check with: docker exec ${STORAGE} true`);
      }),
    );
  }

  it.effect("accepts the gateway's 404 as proof that an exec-failed Kong is up", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => EXEC_FAILED_STATE);
      const gateway = recordingGateway({ "/": 404 });

      const result = yield* settled(
        mock,
        [KONG],
        { execFallbacks: reachableFallback(KONG) },
        gateway.layer,
      );

      expect(result).toEqual({ execUnavailable: [KONG], readinessAssumed: [] });
      expect(gateway.requests).toEqual([
        {
          method: "GET",
          url: `${GATEWAY_URL}/`,
          headers: expect.objectContaining({ apikey: "sb_secret_local" }),
        },
      ]);
    }),
  );

  it.effect("fails an exec-failed Kong whose gateway does not answer", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => EXEC_FAILED_STATE);
      const unreachable = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("connect ECONNREFUSED"),
              }),
            }),
          ),
        ),
      );

      const error = yield* timeoutFailure(
        mock,
        [KONG],
        { execFallbacks: reachableFallback(KONG) },
        unreachable,
      );

      expect(error.unhealthy).toEqual([
        {
          containerId: KONG,
          reason: `container is not ready: HttpClientError: Transport error (GET ${GATEWAY_URL}/)`,
        },
      ]);
      expect(error.suggestion).toContain(`Check with: docker exec ${KONG} true`);
    }),
  );

  it.effect("fails a gateway GET whose body never completes once one probe timeout elapses", () =>
    withSilencedStderr(
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => EXEC_FAILED_STATE);
        const stalledBody = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  new ReadableStream({
                    start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
                  }),
                  { status: 200 },
                ),
              ),
            ),
          ),
        );

        const fiber = yield* settled(
          mock,
          [STORAGE],
          { timeoutSeconds: 0, execFallbacks: gatewayFallback(STORAGE, STORAGE_STATUS_PATH) },
          stalledBody,
        ).pipe(Effect.forkChild({ startImmediately: true }));
        for (let second = 0; second < 9; second++) {
          yield* TestClock.adjust("1 seconds");
        }
        const pendingAtNineSeconds = fiber.pollUnsafe();
        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(pendingAtNineSeconds).toBeUndefined();
        expect(error).toBeInstanceOf(HealthCheckTimeoutError);
        expect(error.unhealthy).toEqual([
          {
            containerId: STORAGE,
            reason: expect.stringMatching(
              /^container is not ready: \/storage\/v1\/status: TimeoutError/u,
            ),
          },
        ]);
      }),
    ),
  );

  it.effect("joins the exec-format and exec-unavailable advice for different containers", () =>
    Effect.gen(function* () {
      const broken = "supabase_inbucket_proj";
      const mock = mockHealthSpawner(
        (containerId) => (containerId === broken ? notRunning : EXEC_FAILED_STATE),
        { [broken]: ["exec /mailpit: exec format error\n"] },
      );

      const error = yield* timeoutFailure(mock, [broken, STUDIO], {
        images: new Map([[broken, "public.ecr.aws/supabase/mailpit:v1.30.2"]]),
      });

      const suggestion = error.suggestion ?? "";
      expect(suggestion).toContain(`${broken}'s image public.ecr.aws/supabase/mailpit:v1.30.2`);
      expect(suggestion).toContain(
        `architecture.\n\nDocker could not run the health check inside ${STUDIO} (`,
      );
      expect(suggestion).not.toContain(`inside ${broken}`);
    }),
  );

  it.effect("does not blame exec for an ordinary failure beside an accepted exec-failed one", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner((containerId) =>
        containerId === STUDIO ? EXEC_FAILED_STATE : orderlyUnhealthy,
      );

      const error = yield* timeoutFailure(mock, [STUDIO, STORAGE], {
        execFallbacks: runningFallback(STUDIO),
      });

      expect(error.unhealthy.map((failure) => failure.containerId)).toEqual([STORAGE]);
      expect(error.suggestion).toBeUndefined();
    }),
  );

  it.effect("reports nothing as exec-unavailable while Docker's health check works", () =>
    Effect.gen(function* () {
      const orderlyStarting = inspectedState({
        health: "starting",
        probes: [{ exitCode: 1, output: "pg_isready: no response" }],
      });
      const mock = mockHealthSpawner((_id, callIndex) =>
        callIndex === 0 ? orderlyStarting : runningHealthy,
      );

      const fiber = yield* settled(mock, [STUDIO], {
        execFallbacks: runningFallback(STUDIO),
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("1 seconds");
      const result = yield* Fiber.join(fiber);

      expect(result).toEqual({ execUnavailable: [], readinessAssumed: [] });
    }),
  );
});

describe("healthCheckExecUnavailableWarning", () => {
  it("names every container whose readiness was not verified", () => {
    const warning = healthCheckExecUnavailableWarning([
      "supabase_realtime_proj",
      "supabase_studio_proj",
    ]);

    expect(warning).toContain("WARNING:");
    expect(warning).toContain("(OCI runtime exec failed)");
    expect(warning).toContain(
      "Readiness of supabase_realtime_proj, supabase_studio_proj was not verified.",
    );
    expect(warning.endsWith("\n")).toBe(true);
  });

  it("says readiness was checked from the host when every container was verified", () => {
    const warning = healthCheckExecUnavailableWarning([]);

    expect(warning).toContain("Readiness was checked from the host instead.");
    expect(warning).not.toContain("was not verified");
  });
});

describe("awaitDockerHealthSettled", () => {
  const DB = "supabase_db_proj";

  const run = (mock: ReturnType<typeof mockHealthSpawner>) =>
    Effect.gen(function* () {
      const fiber = yield* awaitDockerHealthSettled(mock.spawner, DB).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 seconds");
      return yield* Fiber.await(fiber);
    });

  const settlesImmediately: ReadonlyArray<readonly [string, string]> = [
    ["Docker already reports it healthy", runningHealthy],
    ["its health check cannot run on this host", EXEC_FAILED_STATE],
    [
      "an exec failure is recorded while Docker still reports starting",
      inspectedState({
        health: "starting",
        probes: [{ exitCode: -1, output: EXEC_FAILURE_OUTPUT }],
      }),
    ],
    ["it is no longer running", notRunning],
    [
      "Docker reports it unhealthy",
      inspectedState({ health: "unhealthy", probes: [{ exitCode: 1, output: "no response" }] }),
    ],
    ["it has no health check", inspectedState()],
  ];
  for (const [scenario, state] of settlesImmediately) {
    it.effect(`returns after a single inspect when ${scenario}`, () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => state);

        const exit = yield* run(mock);

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(inspectCalls(mock)).toHaveLength(1);
      }),
    );
  }

  it.effect("succeeds without retrying when the inspect itself fails", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => runningStarting, {}, { inspectFails: true });

      const exit = yield* run(mock);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(inspectCalls(mock)).toHaveLength(1);
    }),
  );

  it.effect("keeps polling while Docker reports starting and returns once it settles", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner((_id, callIndex) =>
        callIndex < 2 ? runningStarting : runningHealthy,
      );

      const fiber = yield* awaitDockerHealthSettled(mock.spawner, DB).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 seconds");
      yield* TestClock.adjust("1 seconds");
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(inspectCalls(mock)).toHaveLength(3);
    }),
  );

  it.effect("gives up without failing after 15 seconds of starting, and stops polling", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => runningStarting);

      const fiber = yield* awaitDockerHealthSettled(mock.spawner, DB).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      for (let second = 0; second < 14; second++) {
        yield* TestClock.adjust("1 seconds");
      }
      const pendingAt14Seconds = fiber.pollUnsafe();
      yield* TestClock.adjust("1 seconds");
      const exit = yield* Fiber.await(fiber);
      const pollsAtCap = inspectCalls(mock).length;
      yield* TestClock.adjust("10 seconds");

      expect(pendingAt14Seconds).toBeUndefined();
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(inspectCalls(mock)).toHaveLength(pollsAtCap);
    }),
  );
});
