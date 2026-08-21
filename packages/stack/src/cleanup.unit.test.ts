import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { cleanupAutoManagedPaths } from "./cleanup.ts";

describe("automatic managed-path cleanup", () => {
  it.effect("can be interrupted while waiting to retry a busy path", () =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const fs = FileSystem.makeNoop({
        remove: () => Effect.void,
        exists: () => Deferred.succeed(attempted, undefined).pipe(Effect.as(true)),
      });
      const cleanup = cleanupAutoManagedPaths(["/owned"]).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.ensuring(Deferred.succeed(finished, undefined)),
      );
      const fiber = yield* cleanup.pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(attempted);
      const interruption = yield* Fiber.interrupt(fiber).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      const interruptedBeforeNextRetry = yield* Deferred.isDone(finished);

      yield* TestClock.adjust("20 seconds");
      yield* Fiber.join(interruption);
      expect(interruptedBeforeNextRetry).toBe(true);
    }),
  );

  it.effect("does not retry when path existence cannot be determined", () =>
    Effect.gen(function* () {
      let removalAttempts = 0;
      const fs = FileSystem.makeNoop({
        remove: () =>
          Effect.sync(() => {
            removalAttempts += 1;
          }),
        exists: () =>
          Effect.fail(
            systemError({
              _tag: "PermissionDenied",
              module: "test",
              method: "exists",
            }),
          ),
      });
      const fiber = yield* cleanupAutoManagedPaths(["/owned"]).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* TestClock.adjust("20 seconds");
      yield* Fiber.join(fiber);
      expect(removalAttempts).toBe(1);
    }),
  );
});
