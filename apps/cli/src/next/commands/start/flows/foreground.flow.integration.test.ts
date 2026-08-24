// oxlint-disable effecttsgo/new-promise -- this test injects a deliberately gated foreign Promise to verify shutdown coordination.
import { describe, expect, it } from "@effect/vitest";
import { StackUnavailableError } from "@supabase/stack/effect";
import { makeTestStack } from "@supabase/stack/testing";
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { Ink } from "../../../../shared/runtime/ink.service.ts";
import { Stack } from "@supabase/stack/effect";
import { startForegroundWithStopSignal } from "./foreground.flow.ts";

const inkLayer = Layer.succeed(Ink, {
  render: () =>
    Effect.succeed({
      unmount: () => undefined,
      rerender: () => undefined,
      waitUntilExit: () => new Promise<never>(() => undefined),
    }),
});

describe("start foreground flow", () => {
  it.effect("does not start the runtime when dashboard state initialization fails", () =>
    Effect.gen(function* () {
      let startCalls = 0;
      const stack = {
        ...makeTestStack(),
        getInfo: () => Effect.fail(new StackUnavailableError({ phase: "starting" })),
        start: () =>
          Effect.sync(() => {
            startCalls += 1;
          }),
      };
      const exit = yield* startForegroundWithStopSignal(Effect.never).pipe(
        Effect.provide(Layer.mergeAll(Layer.succeed(Stack, stack), inkLayer)),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(startCalls).toBe(0);
    }),
  );

  it.effect("creates the dashboard state stream before starting the runtime", () =>
    Effect.gen(function* () {
      const stopRequested = Deferred.makeUnsafe<void>();
      const started = Deferred.makeUnsafe<void>();
      let allStateChangesCalled = false;
      let startCalls = 0;
      const stack = {
        ...makeTestStack(),
        start: () =>
          Effect.gen(function* () {
            expect(allStateChangesCalled).toBe(true);
            startCalls += 1;
            yield* Deferred.succeed(started, undefined);
          }),
        allStateChanges: () => {
          allStateChangesCalled = true;
          return Stream.never;
        },
      };
      const fiber = yield* startForegroundWithStopSignal(Deferred.await(stopRequested)).pipe(
        Effect.provide(Layer.mergeAll(Layer.succeed(Stack, stack), inkLayer)),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Deferred.await(started);
      expect(startCalls).toBe(1);
      yield* Deferred.succeed(stopRequested, undefined);
      yield* Fiber.join(fiber);
    }),
  );
});
