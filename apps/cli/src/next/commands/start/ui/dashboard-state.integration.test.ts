import { expect, it } from "@effect/vitest";
import { makeTestStack } from "@supabase/stack/testing";
import { Stack } from "@supabase/stack/effect";
import { Cause, Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
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
