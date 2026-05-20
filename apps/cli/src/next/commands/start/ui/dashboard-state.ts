import { Effect, Layer, Context, Stream, SubscriptionRef } from "effect";
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

      const info = yield* stack.getInfo();
      const initialStates = yield* stack.getAllStates();
      const stackInfoRef = yield* SubscriptionRef.make<StackInfo | null>(info);
      const serviceStatesRef =
        yield* SubscriptionRef.make<ReadonlyArray<StackServiceState>>(initialStates);
      const phaseRef = yield* SubscriptionRef.make<StartPhase>("starting");
      const errorRef = yield* SubscriptionRef.make<string | null>(null);

      yield* stack.allStateChanges().pipe(
        Stream.runForEach((state) =>
          SubscriptionRef.update(serviceStatesRef, (current) =>
            updateServiceStates(current, state),
          ),
        ),
        Effect.ignore,
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
