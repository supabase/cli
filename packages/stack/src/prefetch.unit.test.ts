// oxlint-disable effecttsgo/async-function -- Prefetch tests call the Promise-returning public helper from Vitest callbacks.

import { describe, expect, test } from "vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Queue,
  Result,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { BinaryNotFoundError, DockerPullError } from "./errors.ts";
import { prefetch } from "./prefetch.ts";
import {
  ServiceDownloadFinished,
  ServiceDownloadStarted,
  PreparationCompleted,
  StackPreparation,
} from "./StackPreparation.ts";
import { DEFAULT_VERSIONS, SERVICE_NAMES, dockerImageForService } from "./versions.ts";

const encoder = new TextEncoder();
const defaultAuthGhcrImage = `ghcr.io/supabase/cli/auth:${DEFAULT_VERSIONS.auth}`;

interface SpawnResult {
  readonly exitCode: number;
  readonly stderr?: ReadonlyArray<string>;
  readonly defect?: unknown;
}

function mockSequenceSpawner(results: ReadonlyArray<SpawnResult>) {
  const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  let index = 0;

  return {
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const standardCommand = Predicate.isTagged(command, "StandardCommand");
          const cmd = standardCommand ? command.command : "";
          const args = standardCommand ? command.args : [];
          spawned.push({ command: cmd, args });

          const result = results[index] ?? { exitCode: 0 };
          index += 1;
          if (result.defect !== undefined) {
            return yield* Effect.die(result.defect);
          }

          const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result.exitCode));

          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(2000 + index),
            stdout: Stream.empty,
            stderr: Stream.fromIterable(
              (result.stderr ?? []).map((line) => encoder.encode(`${line}\n`)),
            ),
            all: Stream.empty,
            exitCode: Deferred.await(exitDeferred),
            isRunning: Effect.succeed(true),
            stdin: Sink.drain,
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    get spawned() {
      return spawned;
    },
  };
}

describe("prefetch", () => {
  test("prefetches every native-capable service by default in native mode", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner(
      Array.from({ length: SERVICE_NAMES.length }, () => ({
        exitCode: 0,
      })),
    );

    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(prefetch().pipe(Effect.provide(layer)));

    expect(Object.keys(result).sort()).toEqual(["auth", "postgres", "postgrest"]);
  });

  test("limits concurrent image preparation to four services", async () => {
    const started = await Effect.runPromise(Queue.unbounded<string>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const services = ["postgres", "mailpit", "edge-runtime", "realtime", "pooler"] as const;
    let pullStarts = 0;
    const spawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const standardCommand = Predicate.isTagged(command, "StandardCommand");
          const args = standardCommand ? command.args : [];
          const image = args[1] ?? "unknown";
          if (args[0] === "pull") {
            pullStarts += 1;
            yield* Queue.offer(started, image);
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(3000 + pullStarts),
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: Deferred.await(release).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              isRunning: Effect.succeed(true),
              stdin: Sink.drain,
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }

          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(2000),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            isRunning: Effect.succeed(false),
            stdin: Sink.drain,
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    );
    const layer = StackPreparation.layer.pipe(
      Layer.provide(mockBinaryResolver().layer),
      Layer.provide(spawner),
    );

    const preparation = Effect.runFork(
      prefetch({ mode: "docker", containerRuntime: "docker", services }).pipe(
        Effect.provide(layer),
      ),
    );
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 4 }, () => Queue.take(started)),
        { discard: true },
      ),
    );
    expect(pullStarts).toBe(4);

    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(preparation));
    expect(pullStarts).toBe(5);
  });

  test("marks a Podman daemon disconnect on DockerPullError", async () => {
    const resolver = mockBinaryResolver();
    // One image inspect followed by one canonical pull. Preparation must fail
    // rather than defer the pull to startup.
    const spawner = mockSequenceSpawner([
      { exitCode: 1, stderr: ["not found"] },
      { exitCode: 1, stderr: ["Cannot connect to Podman"] },
    ]);

    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const error = await Effect.runPromise(
      prefetch({ mode: "docker", containerRuntime: "podman", services: ["auth"] }).pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(DockerPullError);
    if (!(error instanceof DockerPullError)) throw error;
    expect(error.daemonDown).toBe(true);
  });

  test("preserves unexpected image pull defects", async () => {
    const defect = new Error("container runtime callback defect");
    const spawner = mockSequenceSpawner([
      { exitCode: 1, stderr: ["not found"] },
      { exitCode: 0, defect },
    ]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(mockBinaryResolver().layer),
      Layer.provide(spawner.layer),
    );

    const exit = await Effect.runPromiseExit(
      prefetch({ mode: "docker", containerRuntime: "docker", services: ["auth"] }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const found = Cause.findDefect(exit.cause);
      expect(Result.isSuccess(found)).toBe(true);
      if (Result.isSuccess(found)) {
        expect(found.success).toBe(defect);
      }
    }
  });

  test("prefetching one service includes its required preparation dependencies", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([{ exitCode: 0 }, { exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      prefetch({ mode: "docker", containerRuntime: "docker", services: ["postgrest"] }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(Object.keys(result).sort()).toEqual(["postgres", "postgrest"]);
  });

  test.each([
    ["storage", "docker", ["imgproxy", "postgres", "storage"]],
    ["imgproxy", "podman", ["imgproxy", "postgres", "storage"]],
    ["vector", "docker", ["analytics", "postgres", "vector"]],
  ] as const)(
    "prefetching %s includes every service it can start through the graph",
    async (service, containerRuntime, expected) => {
      const resolver = mockBinaryResolver();
      const spawner = mockSequenceSpawner([{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }]);
      const layer = StackPreparation.layer.pipe(
        Layer.provide(resolver.layer),
        Layer.provide(spawner.layer),
      );

      const result = await Effect.runPromise(
        prefetch({ mode: "docker", containerRuntime, services: [service] }).pipe(
          Effect.provide(layer),
        ),
      );

      expect(Object.keys(result).sort()).toEqual(expected);
      expect(spawner.spawned).toHaveLength(expected.length);
      expect(spawner.spawned.every(({ command }) => command === containerRuntime)).toBe(true);
      expect(spawner.spawned).toContainEqual({
        command: containerRuntime,
        args: ["image", "inspect", dockerImageForService(service, DEFAULT_VERSIONS[service])],
      });
    },
  );

  test("does not prepare dependencies that are disabled in the stack", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const preparation = yield* StackPreparation;
        return yield* preparation.prepare({
          mode: "docker",
          containerRuntime: "docker",
          services: ["studio"],
          enabledServices: ["postgres", "pgmeta", "studio"],
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(Object.keys(result.resolutions).sort()).toEqual(["pgmeta", "postgres", "studio"]);
  });

  test("Docker mode uses Docker when a native artifact is unavailable", async () => {
    const resolver = mockBinaryResolver({
      binaries: { postgres: "/cache/postgres/native" },
    });
    const spawner = mockSequenceSpawner([{ exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      prefetch({ mode: "docker", containerRuntime: "docker", services: ["postgrest"] }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(result.postgrest).toEqual({
      type: "docker",
      image: `ghcr.io/supabase/cli/postgrest:${DEFAULT_VERSIONS.postgrest}`,
    });
  });

  test("Docker preparation applies the catalog v prefix to bare versions", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([{ exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      prefetch({
        mode: "docker",
        containerRuntime: "docker",
        services: ["postgrest"],
        versions: { postgrest: "16.1" },
      }).pipe(Effect.provide(layer)),
    );

    expect(result.postgrest).toEqual({
      type: "docker",
      image: "ghcr.io/supabase/cli/postgrest:v16.1",
    });
  });

  test("native preparation applies the catalog v prefix before binary resolution", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    await Effect.runPromise(
      prefetch({
        mode: "native",
        services: ["postgrest"],
        versions: { postgrest: "16.1" },
      }).pipe(Effect.provide(layer)),
    );

    expect(resolver.resolved).toContainEqual({ service: "postgrest", version: "v16.1" });
  });

  test("native mode rejects services that have no native runtime", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const error = await Effect.runPromise(
      prefetch({ mode: "native", services: ["edge-runtime"] }).pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(BinaryNotFoundError);
  });

  test("native mode does not fall back when a native artifact is unavailable", async () => {
    const resolver = mockBinaryResolver({ failServices: ["postgrest"] });
    const spawner = mockSequenceSpawner([{ exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const error = await Effect.runPromise(
      prefetch({ mode: "native", services: ["postgrest"] }).pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(BinaryNotFoundError);
    expect(spawner.spawned).toEqual([]);
  });

  test("prefetches pgmeta using its published container tag", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([{ exitCode: 0 }, { exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      prefetch({ mode: "docker", containerRuntime: "docker", services: ["pgmeta"] }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(result.pgmeta).toEqual({
      type: "docker",
      image: dockerImageForService("pgmeta", DEFAULT_VERSIONS.pgmeta),
    });
  });

  test("does not report downloading when the docker image is already cached locally", async () => {
    const resolver = mockBinaryResolver({ failServices: ["auth"] });
    const spawner = mockSequenceSpawner([{ exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const preparation = yield* StackPreparation;
        const streamEvents = yield* preparation
          .prepareEvents({ mode: "docker", containerRuntime: "docker", services: ["auth"] })
          .pipe(Stream.runCollect);
        const downloadEvents = streamEvents.flatMap((event) =>
          event instanceof ServiceDownloadStarted || event instanceof ServiceDownloadFinished
            ? [
                Predicate.isTagged(event, "ServiceDownloadStarted")
                  ? "ServiceDownloadStarted"
                  : "ServiceDownloadFinished",
              ]
            : [],
        );
        const completed = streamEvents.find((event) => event instanceof PreparationCompleted);
        expect(downloadEvents).toEqual([]);
        return completed instanceof PreparationCompleted ? completed.artifacts.resolutions : {};
      }).pipe(Effect.provide(layer)),
    );

    expect(result.auth).toEqual({
      type: "docker",
      image: defaultAuthGhcrImage,
    });
  });

  test("uses Docker for every service in Docker mode", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([{ exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const preparation = yield* StackPreparation;
        const artifacts = yield* preparation.prepare({
          mode: "docker",
          containerRuntime: "docker",
          services: ["edge-runtime"],
        });
        return artifacts.resolutions;
      }).pipe(Effect.provide(layer)),
    );

    expect(result["edge-runtime"]).toEqual({
      type: "docker",
      image: `ghcr.io/supabase/cli/edge-runtime:${DEFAULT_VERSIONS["edge-runtime"]}`,
    });
    expect(resolver.resolved).toEqual([]);
  });

  test("concurrent prefetches share one materialization and return the same result", async () => {
    const [result, resolved] = await Effect.runPromise(
      Effect.gen(function* () {
        const preparationStarted = yield* Deferred.make<void>();
        const releasePreparation = yield* Deferred.make<void>();
        const resolver = mockBinaryResolver({
          downloadedServices: ["auth"],
          beforeResolve: ({ service }) =>
            service === "auth"
              ? Deferred.succeed(preparationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releasePreparation)),
                )
              : Effect.void,
        });
        const layer = StackPreparation.layer.pipe(
          Layer.provide(resolver.layer),
          Layer.provide(mockSequenceSpawner([]).layer),
        );
        return yield* Effect.gen(function* () {
          const first = yield* prefetch({ mode: "native", services: ["auth"] }).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(preparationStarted);
          const second = yield* prefetch({ mode: "native", services: ["auth"] }).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.succeed(releasePreparation, undefined);
          return [
            yield* Effect.all([Fiber.join(first), Fiber.join(second)]),
            resolver.resolved,
          ] as const;
        }).pipe(Effect.provide(layer));
      }),
    );

    expect(result[0]).toEqual(result[1]);
    expect(resolved.filter(({ service }) => service === "auth")).toHaveLength(1);
  });
});
