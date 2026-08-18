import { describe, expect, test } from "vitest";
import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { DockerPullError } from "./errors.ts";
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
  test("prefetches all services by default", async () => {
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

    expect(Object.keys(result).sort()).toEqual([...SERVICE_NAMES].sort());
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
      prefetch({ mode: "docker", services: ["auth"] }).pipe(Effect.provide(layer), Effect.flip),
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
      prefetch({ mode: "docker", services: ["postgrest"] }).pipe(Effect.provide(layer)),
    );

    expect(Object.keys(result).sort()).toEqual(["postgres", "postgrest"]);
  });

  test("prefetches pgmeta using its published container tag", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([{ exitCode: 0 }, { exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      prefetch({ mode: "docker", services: ["pgmeta"] }).pipe(Effect.provide(layer)),
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
          .prepareEvents({ mode: "docker", services: ["auth"] })
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

  test("uses docker for edge-runtime in auto mode even when a native binary exists", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([{ exitCode: 0 }]);
    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const preparation = yield* StackPreparation;
        const artifacts = yield* preparation.prepare({ mode: "auto", services: ["edge-runtime"] });
        return artifacts.resolutions;
      }).pipe(Effect.provide(layer)),
    );

    expect(result["edge-runtime"]).toEqual({
      type: "docker",
      image: `ghcr.io/supabase/cli/edge-runtime:${DEFAULT_VERSIONS["edge-runtime"]}`,
    });
    expect(resolver.resolved).toEqual([
      { service: "postgres", version: DEFAULT_VERSIONS.postgres },
    ]);
  });
});
