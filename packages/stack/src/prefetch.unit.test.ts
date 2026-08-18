import { describe, expect, test } from "vitest";
import { Deferred, Effect, Fiber, Layer, Sink, Stream } from "effect";
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
import { DEFAULT_VERSIONS, SERVICE_NAMES } from "./versions.ts";

const encoder = new TextEncoder();
const defaultAuthGhcrImage = `ghcr.io/supabase/cli/auth:${DEFAULT_VERSIONS.auth}`;

interface SpawnResult {
  readonly exitCode: number;
  readonly stderr?: ReadonlyArray<string>;
}

function mockSequenceSpawner(results: ReadonlyArray<SpawnResult>) {
  const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  let index = 0;

  return {
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const cmd = command._tag === "StandardCommand" ? command.command : "";
          const args = command._tag === "StandardCommand" ? command.args : [];
          spawned.push({ command: cmd, args });

          const result = results[index] ?? { exitCode: 0 };
          index += 1;

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

  test("preparation fails with DockerPullError when the canonical image fails", async () => {
    const resolver = mockBinaryResolver({ failServices: ["auth"] });
    // One image inspect followed by one canonical pull. Preparation must fail
    // rather than defer the pull to startup.
    const spawner = mockSequenceSpawner([
      { exitCode: 1, stderr: ["manifest unknown"] },
      { exitCode: 1, stderr: ["manifest unknown"] },
      { exitCode: 1, stderr: ["manifest unknown"] },
      { exitCode: 1, stderr: ["manifest unknown"] },
    ]);

    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const error = await Effect.runPromise(
      prefetch({ mode: "docker", containerRuntime: "docker", services: ["auth"] }).pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(DockerPullError);
    expect(spawner.spawned).toHaveLength(2);
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

  test("prefetching storage includes the companion it starts", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      prefetch({ mode: "docker", containerRuntime: "docker", services: ["storage"] }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(Object.keys(result).sort()).toEqual(["imgproxy", "postgres", "storage"]);
  });

  test("prefetching uses the selected container runtime without pulling an owner", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([{ exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      prefetch({ mode: "docker", containerRuntime: "podman", services: ["imgproxy"] }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(Object.keys(result)).toEqual(["imgproxy"]);
    expect(spawner.spawned).toEqual([
      {
        command: "podman",
        args: ["image", "inspect", `ghcr.io/supabase/cli/imgproxy:${DEFAULT_VERSIONS.imgproxy}`],
      },
    ]);
  });

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
      image: "ghcr.io/supabase/cli/pgmeta:v0.98.0",
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
            ? [event._tag]
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
