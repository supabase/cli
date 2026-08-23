import { Cause, Context, Effect, Exit, Layer, Stream, SubscriptionRef } from "effect";
import type { StackServiceState, StackInfo } from "@supabase/stack/effect";
import { Stack } from "@supabase/stack/effect";

export type StartPhase = "starting" | "running" | "failed" | "stopping";

function updateServiceStates(
  current: ReadonlyArray<StackServiceState>,
  state: StackServiceState,
): ReadonlyArray<StackServiceState> {
  return current.some((entry) => entry.name === state.name)
    ? current.map((entry) => (entry.name === state.name ? state : entry))
    : [...current, state];
}

export class StartDashboardState extends Context.Service<
  StartDashboardState,
  {
    readonly stackInfoRef: SubscriptionRef.SubscriptionRef<StackInfo | null>;
    readonly serviceStatesRef: SubscriptionRef.SubscriptionRef<ReadonlyArray<StackServiceState>>;
    readonly phaseRef: SubscriptionRef.SubscriptionRef<StartPhase>;
    readonly errorRef: SubscriptionRef.SubscriptionRef<string | null>;
  }
>()("supabase/start/StartDashboardState") {
  static readonly live = Layer.effect(
    this,
    Effect.gen(function* () {
      const stack = yield* Stack;

      const initial = yield* Effect.all([stack.getInfo(), stack.getAllStates()]).pipe(Effect.exit);
      const stackInfoRef = yield* SubscriptionRef.make<StackInfo | null>(
        Exit.isSuccess(initial) ? initial.value[0] : null,
      );
      const serviceStatesRef = yield* SubscriptionRef.make<ReadonlyArray<StackServiceState>>(
        Exit.isSuccess(initial) ? initial.value[1] : [],
      );
      const phaseRef = yield* SubscriptionRef.make<StartPhase>("starting");
      const errorRef = yield* SubscriptionRef.make<string | null>(null);

      if (Exit.isFailure(initial)) {
        yield* SubscriptionRef.set(errorRef, Cause.pretty(initial.cause));
        yield* SubscriptionRef.set(phaseRef, "failed");
        return { stackInfoRef, serviceStatesRef, phaseRef, errorRef };
      }

      yield* stack.allStateChanges().pipe(
        Stream.runForEach((state) =>
          SubscriptionRef.update(serviceStatesRef, (current) =>
            updateServiceStates(current, state),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.all([
            SubscriptionRef.set(errorRef, Cause.pretty(cause)),
            SubscriptionRef.set(phaseRef, "failed"),
          ]).pipe(Effect.asVoid),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );

      return {
        stackInfoRef,
        serviceStatesRef,
        phaseRef,
        errorRef,
      };
    }),
  );
}
