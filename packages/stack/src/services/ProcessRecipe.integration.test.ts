import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Crypto, Deferred, Effect, Fiber, FileSystem, Layer, Path, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ContainerRuntime } from "../runtime/Container.ts";
import { makeService } from "../Service.ts";
import { makeProcessRecipe } from "./ProcessRecipe.ts";
import * as Realtime from "./Realtime.ts";

const encode = (text: string) => new TextEncoder().encode(text);

const poolTimeout =
  "** (DBConnection.ConnectionError) connection not available and request was dropped from queue";

const postgrexFailure =
  '[error] Postgrex.Protocol ("db_conn_1") failed to connect: ** (DBConnection.ConnectionError) tcp connect (host.docker.internal:54322): network is unreachable - :enetunreach';

const startupContainer = (tool: {
  readonly stdout: Stream.Stream<string>;
  readonly stderr: Stream.Stream<string>;
  readonly exitCode: Effect.Effect<number>;
}): ContainerRuntime => ({
  prepare: () => Effect.void,
  launch: () => Effect.die("the main process must not launch after a failed startup"),
  launchTool: () =>
    Effect.succeed({
      id: "startup-tool",
      ports: {},
      stdout: tool.stdout.pipe(Stream.map(encode)),
      stderr: tool.stderr.pipe(Stream.map(encode)),
      exitCode: tool.exitCode,
      stdin: Sink.drain,
      stop: Effect.void,
      discard: Effect.void,
      kill: Effect.void,
      remove: Effect.void,
    }),
});

const realtimeService = Effect.fn(function* (container: ContainerRuntime) {
  const creation: Realtime.Creation = {
    service: "realtime",
    config: { databaseUrl: "postgresql://postgres:postgres@host.docker.internal:54322/postgres" },
  };
  const recipe = yield* makeProcessRecipe(
    creation,
    {
      stackId: "process-recipe-test",
      instanceId: "instance",
      root: "/unused",
      cacheRoot: "/unused/cache",
      runtime: "docker",
    },
    {
      fs: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      client: yield* HttpClient.HttpClient,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      container,
    },
    Realtime.makeSpec(),
  );
  return yield* makeService(recipe.definition, { id: "realtime", config: creation });
});

const platform = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

describe("process recipe startup", () => {
  it.effect("reports the startup process's recent stdout and stderr when it exits non-zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const realtime = yield* realtimeService(
          startupContainer({
            stdout: Stream.make(
              "[info] Running migrations\n",
              postgrexFailure.slice(0, 60),
              `${postgrexFailure.slice(60)}\n`,
            ),
            stderr: Stream.make(`${poolTimeout}\n`),
            exitCode: Effect.succeed(1),
          }),
        );

        const error = yield* Effect.flip(realtime.start);

        expect(error.message).toContain("realtime startup exited with 1");
        expect(error.message).toContain(postgrexFailure);
        expect(error.message).toContain(poolTimeout);
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.effect("keeps the stderr error when later stdout exceeds the tail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stderrWritten = yield* Deferred.make<void>();
        const noise = Array.from({ length: 30 }, (_, index) => `[info] shutdown step ${index}\n`);
        const realtime = yield* realtimeService(
          startupContainer({
            stdout: Stream.fromEffectDrain(Deferred.await(stderrWritten)).pipe(
              Stream.concat(Stream.fromIterable(noise)),
            ),
            stderr: Stream.make(`${poolTimeout}\n`).pipe(
              Stream.concat(Stream.fromEffectDrain(Deferred.succeed(stderrWritten, undefined))),
            ),
            exitCode: Effect.succeed(1),
          }),
        );

        const error = yield* Effect.flip(realtime.start);

        expect(error.message).toContain(poolTimeout);
        expect(error.message).toContain("[info] shutdown step 29");
        expect(error.message).not.toContain("[info] shutdown step 9\n");
      }),
    ).pipe(Effect.provide(platform)),
  );

  it.effect(
    "reports the startup process's recent output, including an unterminated line, when it never exits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* Deferred.make<void>();
          const realtime = yield* realtimeService(
            startupContainer({
              stdout: Stream.make(
                `${postgrexFailure}\n`,
                "[info] ",
                "😀".repeat(2_500),
                " Retrying database connection",
              ).pipe(
                Stream.concat(Stream.fromEffectDrain(Deferred.succeed(running, undefined))),
                Stream.concat(Stream.never),
              ),
              stderr: Stream.never,
              exitCode: Effect.never,
            }),
          );

          const failure = yield* realtime.start.pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(running);
          yield* Effect.yieldNow;
          yield* TestClock.adjust("60 seconds");
          const error = yield* Fiber.join(failure);

          expect(error.message).toContain("realtime startup timed out after 60 seconds");
          expect(error.message).toContain(postgrexFailure);
          expect(error.message).toContain("😀 Retrying database connection");
          expect(error.message).not.toContain("[info] 😀");
          expect(error.message).not.toMatch(/…[\uDC00-\uDFFF]/);
          expect(error.message.length).toBeLessThan(2_000);
        }),
      ).pipe(Effect.provide(platform)),
  );
});
