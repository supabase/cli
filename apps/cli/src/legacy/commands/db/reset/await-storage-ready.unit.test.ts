import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as TestClock from "effect/testing/TestClock";

import { LegacyHealthCheckTimeoutError } from "../../../shared/containers/health-check.ts";
import { legacyAwaitStorageReady } from "./await-storage-ready.ts";

const unusedHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("HttpClient should not be called for a plain container check")),
);

function mockSpawner(
  handler: (args: ReadonlyArray<string>) => { exitCode: number; stdout?: string; stderr?: string },
) {
  const spawned: Array<ReadonlyArray<string>> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);
      const result = handler(args);

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result.exitCode));

      const encoder = new TextEncoder();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable(
          result.stdout !== undefined ? [encoder.encode(result.stdout)] : [],
        ),
        stderr: Stream.fromIterable(
          result.stderr !== undefined ? [encoder.encode(result.stderr)] : [],
        ),
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

const HEALTHY_STATE = '{"Running":true,"Status":"running","Health":{"Status":"healthy"}}';
const STARTING_STATE = '{"Running":true,"Status":"running","Health":{"Status":"starting"}}';

describe("legacyAwaitStorageReady", () => {
  it.live("resolves true immediately when storage already reports healthy", () => {
    const mock = mockSpawner(() => ({ exitCode: 0, stdout: HEALTHY_STATE }));
    return legacyAwaitStorageReady(mock.spawner, "proj").pipe(
      Effect.provide(unusedHttpClientLayer),
      Effect.map((ready) => {
        expect(ready).toBe(true);
        // No `docker logs`/extra polling round needed — just the one inspect.
        expect(mock.spawned).toHaveLength(1);
      }),
    );
  });

  it.live('resolves false on ANY inspect error — not just a confirmed "not found"', () => {
    const mock = mockSpawner(() => ({
      exitCode: 1,
      stderr: "Cannot connect to the Docker daemon\n",
    }));
    return legacyAwaitStorageReady(mock.spawner, "proj").pipe(
      Effect.provide(unusedHttpClientLayer),
      Effect.map((ready) => {
        expect(ready).toBe(false);
      }),
    );
  });

  it.live('resolves false when storage genuinely does not exist ("No such container")', () => {
    const mock = mockSpawner(() => ({
      exitCode: 1,
      stderr: "Error: No such container: supabase_storage_proj\n",
    }));
    return legacyAwaitStorageReady(mock.spawner, "proj").pipe(
      Effect.provide(unusedHttpClientLayer),
      Effect.map((ready) => {
        expect(ready).toBe(false);
      }),
    );
  });

  it.effect(
    "waits up to the hardcoded 30s for an unhealthy-but-present container, then succeeds",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const mock = mockSpawner((args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            calls++;
            return { exitCode: 0, stdout: calls === 1 ? STARTING_STATE : HEALTHY_STATE };
          }
          return { exitCode: 0 };
        });

        const fiber = yield* legacyAwaitStorageReady(mock.spawner, "proj").pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("1 seconds");
        const exit = yield* Fiber.await(fiber);

        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) expect(exit.value).toBe(true);
      }),
  );

  it.effect(
    "FAILS THE WHOLE RESET (not just 'skip buckets') when storage never becomes healthy within 30s",
    () =>
      Effect.gen(function* () {
        const mock = mockSpawner((args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            return { exitCode: 0, stdout: STARTING_STATE };
          }
          return { exitCode: 0 };
        });

        const fiber = yield* legacyAwaitStorageReady(mock.spawner, "proj").pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );
        // Go's hardcoded 30-second wait (`start.WaitForHealthyService(ctx, 30*time.Second,
        // utils.StorageId)`, reset.go:121) — 30 retries after the initial attempt.
        for (let i = 0; i < 30; i++) {
          yield* TestClock.adjust("1 seconds");
        }
        const exit = yield* Fiber.await(fiber);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(LegacyHealthCheckTimeoutError);
        }
      }),
  );

  it.effect(
    "is still retrying after 29 seconds, but fails once the 30th second is exhausted — pins Go's hardcoded 30s constant",
    () =>
      Effect.gen(function* () {
        const mock = mockSpawner((args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            return { exitCode: 0, stdout: STARTING_STATE };
          }
          return { exitCode: 0 };
        });

        const fiber = yield* legacyAwaitStorageReady(mock.spawner, "proj").pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );

        for (let i = 0; i < 29; i++) {
          yield* TestClock.adjust("1 seconds");
        }
        // Not yet exhausted — 29 retries is one short of the hardcoded 30-second cap. If this
        // constant were ever accidentally shortened (e.g. to 3s), the fiber would already be
        // done here, failing this assertion instead of silently passing.
        expect(fiber.pollUnsafe()).toBeUndefined();

        // The 30th second crosses the boundary.
        yield* TestClock.adjust("1 seconds");
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
      }),
  );
});
