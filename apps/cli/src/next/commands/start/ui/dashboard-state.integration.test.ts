import { expect, it } from "@effect/vitest";
import { makeTestStack } from "@supabase/stack/testing";
import { Stack, StackRpcProtocolError, StackUnavailableError } from "@supabase/stack/effect";
import { Cause, Context, Deferred, Effect, Fiber, Layer, Stream, SubscriptionRef } from "effect";
import { StartDashboardState } from "./dashboard-state.ts";

it.live("does not report RPC stream interruption as a dashboard failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const stack = {
        ...makeTestStack(),
        allStateChanges: () => Stream.failCause(Cause.interrupt()),
      };
      const context = yield* Layer.build(
        StartDashboardState.live.pipe(Layer.provide(Layer.succeed(Stack, stack))),
      );
      const state = Context.get(context, StartDashboardState);
      yield* Effect.yieldNow;

      expect(yield* SubscriptionRef.get(state.phaseRef)).toBe("starting");
      expect(yield* SubscriptionRef.get(state.errorRef)).toBeNull();
    }),
  ),
);

it.live("renders graceful state-stream completion as stopping", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscribed = Deferred.makeUnsafe<void>();
      const stack = {
        ...makeTestStack(),
        allStateChanges: () =>
          Stream.unwrap(Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.empty))),
      };
      const context = yield* Layer.build(
        StartDashboardState.live.pipe(Layer.provide(Layer.succeed(Stack, stack))),
      );
      const state = Context.get(context, StartDashboardState);
      const stopping = yield* SubscriptionRef.changes(state.phaseRef).pipe(
        Stream.filter((phase) => phase === "stopping"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* Deferred.await(subscribed);
      yield* Fiber.join(stopping);
      expect(yield* SubscriptionRef.get(state.phaseRef)).toBe("stopping");
      expect(yield* SubscriptionRef.get(state.errorRef)).toBeNull();
    }),
  ),
);

it.live("keeps genuine state-stream errors as failed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscribed = Deferred.makeUnsafe<void>();
      const stack = {
        ...makeTestStack(),
        allStateChanges: () =>
          Stream.unwrap(
            Deferred.succeed(subscribed, undefined).pipe(
              Effect.as(
                Stream.fail(
                  new StackRpcProtocolError({
                    endpoint: "http://127.0.0.1:54321",
                    procedure: "WatchServiceStates",
                    detail: "state stream failed",
                  }),
                ),
              ),
            ),
          ),
      };
      const context = yield* Layer.build(
        StartDashboardState.live.pipe(Layer.provide(Layer.succeed(Stack, stack))),
      );
      const state = Context.get(context, StartDashboardState);
      const failed = yield* SubscriptionRef.changes(state.phaseRef).pipe(
        Stream.filter((phase) => phase === "failed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* Deferred.await(subscribed);
      yield* Fiber.join(failed);
      expect(yield* SubscriptionRef.get(state.phaseRef)).toBe("failed");
      expect(yield* SubscriptionRef.get(state.errorRef)).toContain("StackRpcProtocolError");
    }),
  ),
);

it.live("renders a failure terminal reason as failed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscribed = Deferred.makeUnsafe<void>();
      const stack = {
        ...makeTestStack(),
        allStateChanges: () =>
          Stream.unwrap(
            Deferred.succeed(subscribed, undefined).pipe(
              Effect.as(
                Stream.fail(
                  new StackUnavailableError({
                    phase: "failed",
                    detail: "Local stack disposed unexpectedly",
                  }),
                ),
              ),
            ),
          ),
      };
      const context = yield* Layer.build(
        StartDashboardState.live.pipe(Layer.provide(Layer.succeed(Stack, stack))),
      );
      const state = Context.get(context, StartDashboardState);
      const failed = yield* SubscriptionRef.changes(state.phaseRef).pipe(
        Stream.filter((phase) => phase === "failed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* Deferred.await(subscribed);
      yield* Fiber.join(failed);
      expect(yield* SubscriptionRef.get(state.phaseRef)).toBe("failed");
      expect(yield* SubscriptionRef.get(state.errorRef)).toContain("StackUnavailableError");
    }),
  ),
);
