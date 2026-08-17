import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import { LegacyDbConnectError } from "../legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "../legacy-db-connection.service.ts";
import {
  LegacyHealthCheckTimeoutError,
  legacyWaitForHealthyServices,
  legacyWaitForShadowReady,
  type LegacyHealthCheckPostgrestGateway,
} from "./health-check.ts";

/**
 * Ends a scripted `logs` script, failing the stream after the chunks before it
 * have already been emitted — the real "daemon dropped the pipe mid-dump" case.
 */
const LOG_STREAM_FAILS = Symbol("log stream fails");

/**
 * A spawner that answers `docker container inspect`/`docker logs` calls.
 * `inspectResponse` is called once per `(containerId, callIndex)` pair — the
 * `callIndex` (0-based, per container) lets a test script a container's
 * health across successive polling rounds. `docker logs` calls (the
 * timeout-path debug dump) succeed with whatever `logs` scripts for that
 * container — an array so a test can script chunk boundaries, optionally
 * terminated by {@link LOG_STREAM_FAILS} — and with empty output otherwise.
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
        return yield* Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: `${binary}: command not found`,
          }),
        );
      }
      spawned.push(args);

      let stdoutChunks: LogChunks = [];
      let stderrChunks: LogChunks = [];
      if (args[0] === "container" && args[1] === "inspect") {
        const containerId = args[2] ?? "";
        if (opts.beforeInspect !== undefined) {
          yield* opts.beforeInspect(containerId);
        }
        const callIndex = counts.get(containerId) ?? 0;
        counts.set(containerId, callIndex + 1);
        stdoutChunks = [inspectResponse(containerId, callIndex)];
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
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(0));
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
 * `legacyWaitForHealthyServices` structurally requires `HttpClient.HttpClient`
 * (only exercised on the PostgREST HTTP-HEAD branch) — every test provides
 * some `HttpClient.HttpClient`, and this one fails loudly if a
 * container-only-health-check test ever calls it unexpectedly.
 */
const unusedHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("HttpClient should not be called for a plain container check")),
);

describe("legacyWaitForHealthyServices", () => {
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

      const fiber = yield* legacyWaitForHealthyServices(
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

        const fiber = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_kong_proj"], {
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

        const fiber = yield* legacyWaitForHealthyServices(
          mock.spawner,
          ["supabase_kong_proj", "supabase_rest_proj"],
          { timeoutSeconds: 2 },
        ).pipe(Effect.provide(unusedHttpClientLayer), Effect.forkChild({ startImmediately: true }));

        // 2 retries after the initial attempt (Go's `WithMaxRetries(..., timeout.Seconds())`).
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
        // The healthy container is probed exactly once, then narrowed out of
        // the "still watching" set — the unhealthy one is probed on every round.
        expect(kongCalls).toHaveLength(1);
        expect(restCalls).toHaveLength(3);
      }),
  );

  it.effect(
    "fails with LegacyHealthCheckTimeoutError carrying only the still-unhealthy container's reason",
    () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => notRunning);

        const fiber = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
        }).pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
        expect(error.unhealthy).toEqual([
          { containerId: "supabase_rest_proj", reason: "container is not running: exited" },
        ]);
        expect(error.message).toBe("supabase_rest_proj container is not running: exited");
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
        const fiber = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
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
        const fiber = yield* legacyWaitForHealthyServices(mock.spawner, containerIds, {
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

        // A dropped pipe part-way through the dump must not discard a marker the
        // scanner already matched — that is exactly when this bug class shows up.
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
        // Where the container runtime actually writes it: `docker logs` demuxes
        // the container's stderr onto its own stderr pipe, so this is the real
        // path, not the stdout one every other scenario here scripts.
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

        // Both containers are named against the shared image...
        expect(error.suggestion).toContain("supabase_rest_proj's image");
        expect(error.suggestion).toContain("supabase_realtime_proj's image");
        // ...which the removal command lists once, not twice.
        expect(error.suggestion).toContain(
          "docker image rm -f public.ecr.aws/supabase/postgrest:v14.15",
        );
        expect(error.suggestion).not.toContain(
          "postgrest:v14.15 public.ecr.aws/supabase/postgrest:v14.15",
        );
        // The healthy-logged container's own image is never suggested.
        expect(error.suggestion).not.toContain("storage-api");
      }),
    );
  });

  describe("PostgREST HTTP-HEAD readiness", () => {
    function postgrestGateway(secretKey: string): LegacyHealthCheckPostgrestGateway {
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

        const exit = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
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

        const exit = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
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

        const fiber = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
          postgrest: postgrestGateway("sb_secret_local"),
        }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
        expect(error.unhealthy).toEqual([
          { containerId: "supabase_rest_proj", reason: "unexpected status 503" },
        ]);
      }),
    );
  });

  describe("Edge Runtime HTTP-HEAD readiness", () => {
    function edgeRuntimeGateway(secretKey: string): LegacyHealthCheckPostgrestGateway {
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

        const exit = yield* legacyWaitForHealthyServices(
          mock.spawner,
          ["supabase_edge_runtime_proj"],
          {
            timeoutSeconds: 1,
            edgeRuntime: edgeRuntimeGateway("sb_secret_local"),
          },
        ).pipe(Effect.provide(layer), Effect.exit);

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

        const fiber = yield* legacyWaitForHealthyServices(
          mock.spawner,
          ["supabase_edge_runtime_proj"],
          {
            timeoutSeconds: 1,
            edgeRuntime: edgeRuntimeGateway("sb_secret_local"),
          },
        ).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
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

          const exit = yield* legacyWaitForHealthyServices(
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

const shadowConnConfig: LegacyPgConnInput = {
  host: "127.0.0.1",
  port: 54320,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

/**
 * A `LegacyDbConnection` whose `connect` fails the first `failTimes` calls
 * (`Number.POSITIVE_INFINITY` never succeeds), recording every dialled config
 * and how many probe sessions were released. `closedSessions` is what proves
 * the readiness probe hands nothing back to the caller: the downstream code
 * opens its own connection through `legacyConnectShadowDatabase` afterwards.
 */
function mockShadowDbConnection(
  opts: { readonly failTimes?: number; readonly connectMillis?: number } = {},
) {
  const failTimes = opts.failTimes ?? 0;
  const session: LegacyDbSession = {
    exec: () => Effect.void,
    query: () => Effect.succeed([]),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  const attempts: Array<LegacyPgConnInput> = [];
  let closedSessions = 0;
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: (cfg) =>
      Effect.gen(function* () {
        attempts.push(cfg);
        // A dial that hangs before answering — how a real attempt burns its own connect timeout.
        if (opts.connectMillis !== undefined) yield* Effect.sleep(opts.connectMillis);
        if (attempts.length <= failTimes) {
          return yield* Effect.fail(new LegacyDbConnectError({ message: "connection refused" }));
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

describe("legacyWaitForShadowReady", () => {
  it.effect(
    "resolves on the first successful connect, while Docker still reports the healthcheck as starting",
    () =>
      Effect.gen(function* () {
        // The shadow container's healthcheck runs on a 10s interval with no
        // start period, so Docker cannot report `healthy` before t+10s even
        // though Postgres accepts connections at ~3.5s — the whole point of
        // this wait is that the health status is never consulted at all.
        const mock = mockHealthSpawner(() => runningStarting);
        const db = mockShadowDbConnection();

        const exit = yield* legacyWaitForShadowReady(
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

  it.effect("keeps polling a refused connect on a 1-second backoff until it succeeds", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => runningStarting);
      const db = mockShadowDbConnection({ failTimes: 2 });

      const fiber = yield* legacyWaitForShadowReady(
        mock.spawner,
        SHADOW_CONTAINER_ID,
        shadowConnConfig,
        { timeoutSeconds: 30 },
      ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("1 seconds");
      yield* TestClock.adjust("1 seconds");
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isSuccess(exit)).toBe(true);
      // 2 refused attempts, then the 3rd that connects — a refused connect is
      // "not ready yet", never an error in its own right.
      expect(db.attempts).toHaveLength(3);
      expect(inspectCalls(mock)).toHaveLength(3);
      expect(db.closedSessions).toBe(1);
    }),
  );

  it.effect(
    "fails with LegacyHealthCheckTimeoutError and dumps the container's logs when it never becomes connectable",
    () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningStarting);
        const db = mockShadowDbConnection({ failTimes: Number.POSITIVE_INFINITY });

        const error = yield* withSilencedStderr(
          Effect.gen(function* () {
            const fiber = yield* legacyWaitForShadowReady(
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

        expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
        expect(error.unhealthy).toEqual([
          { containerId: SHADOW_CONTAINER_ID, reason: "connection refused" },
        ]);
        expect(error.message).toBe(`${SHADOW_CONTAINER_ID} connection refused`);
        // 1 initial attempt + `timeoutSeconds` retries, same budget as the
        // Docker-health gate this replaces.
        expect(db.attempts).toHaveLength(3);
        expect(
          mock.spawned.some((args) => args[0] === "logs" && args[1] === SHADOW_CONTAINER_ID),
        ).toBe(true);
      }),
  );

  it.effect("stops on elapsed time, not on the retry count, when every attempt hangs", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => runningStarting);
      // 1.2s per dial: the round trip is now 2.2s (dial + the 1-second backoff), so the
      // `timeoutSeconds` retry count alone would keep polling until t=7.8s.
      const db = mockShadowDbConnection({
        failTimes: Number.POSITIVE_INFINITY,
        connectMillis: 1200,
      });

      const error = yield* withSilencedStderr(
        Effect.gen(function* () {
          const fiber = yield* legacyWaitForShadowReady(
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
      expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
      expect(error.message).toBe(`${SHADOW_CONTAINER_ID} connection refused`);
      expect(error.unhealthy).toEqual([
        { containerId: SHADOW_CONTAINER_ID, reason: "connection refused" },
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
          const fiber = yield* legacyWaitForShadowReady(
            mock.spawner,
            SHADOW_CONTAINER_ID,
            shadowConnConfig,
            { timeoutSeconds: 30 },
          ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

          yield* TestClock.adjust("1 seconds");
          return yield* Fiber.join(fiber).pipe(Effect.flip);
        }),
      );

      expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
      expect(error.unhealthy).toEqual([
        { containerId: SHADOW_CONTAINER_ID, reason: "container is not running: exited" },
      ]);
      // A dead container can never become connectable — one second in, not 30.
      expect(inspectCalls(mock)).toHaveLength(2);
      expect(db.attempts).toHaveLength(1);
      expect(
        mock.spawned.some((args) => args[0] === "logs" && args[1] === SHADOW_CONTAINER_ID),
      ).toBe(true);
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
            const fiber = yield* legacyWaitForShadowReady(
              mock.spawner,
              SHADOW_CONTAINER_ID,
              shadowConnConfig,
              { timeoutSeconds: 1, image: "public.ecr.aws/supabase/postgres:15.1.0.147" },
            ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

            yield* TestClock.adjust("1 seconds");
            return yield* Fiber.join(fiber).pipe(Effect.flip);
          }),
        );

        expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
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
            const fiber = yield* legacyWaitForShadowReady(
              mock.spawner,
              SHADOW_CONTAINER_ID,
              shadowConnConfig,
              { timeoutSeconds: 1 },
            ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

            yield* TestClock.adjust("1 seconds");
            return yield* Fiber.join(fiber).pipe(Effect.flip);
          }),
        );

        expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
        expect(error.suggestion).toBeUndefined();
      }),
    );

    it.effect("stays silent for a plain not-ready timeout even when an image is named", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningStarting);
        const db = mockShadowDbConnection({ failTimes: Number.POSITIVE_INFINITY });

        const error = yield* withSilencedStderr(
          Effect.gen(function* () {
            const fiber = yield* legacyWaitForShadowReady(
              mock.spawner,
              SHADOW_CONTAINER_ID,
              shadowConnConfig,
              { timeoutSeconds: 1, image: "public.ecr.aws/supabase/postgres:15.1.0.147" },
            ).pipe(Effect.provide(db.layer), Effect.forkChild({ startImmediately: true }));

            yield* TestClock.adjust("1 seconds");
            return yield* Fiber.join(fiber).pipe(Effect.flip);
          }),
        );

        expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
        expect(error.suggestion).toBeUndefined();
      }),
    );
  });
});
