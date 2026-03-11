import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { ServiceState } from "@supabase/stack";
import type { StackInfo } from "@supabase/stack/internals";
import { Effect, Layer } from "effect";
import { StartDashboardState, type StartPhase } from "./dashboard-state.ts";
import { toDisplayStates } from "./display-states.ts";

export type { StartPhase } from "./dashboard-state.ts";

export interface StartDashboardModel {
  readonly serviceStatesStateAtom: Atom.Writable<
    AsyncResult.AsyncResult<ReadonlyArray<ServiceState>, never>,
    ReadonlyArray<ServiceState>
  >;
  readonly stackInfoStateAtom: Atom.Writable<
    AsyncResult.AsyncResult<StackInfo | null, never>,
    StackInfo | null
  >;
  readonly phaseStateAtom: Atom.Writable<AsyncResult.AsyncResult<StartPhase, never>, StartPhase>;
  readonly errorStateAtom: Atom.Writable<
    AsyncResult.AsyncResult<string | null, never>,
    string | null
  >;
  readonly serviceStatesAtom: Atom.Writable<ReadonlyArray<ServiceState>>;
  readonly stackInfoAtom: Atom.Writable<StackInfo | null>;
  readonly phaseAtom: Atom.Writable<StartPhase>;
  readonly errorAtom: Atom.Writable<string | null>;
  readonly displayStatesAtom: Atom.Atom<ReadonlyArray<ServiceState>>;
  readonly allHealthyAtom: Atom.Atom<boolean>;
  readonly statusLineAtom: Atom.Atom<string>;
}

function fromResultAtom<A>(
  atom: Atom.Writable<AsyncResult.AsyncResult<A, never>, A>,
  fallback: A,
): Atom.Writable<A> {
  return Atom.writable(
    (get) => AsyncResult.getOrElse(get(atom), () => fallback),
    (ctx, value: A) => {
      ctx.set(atom, value);
    },
  );
}

export function createStartDashboardModel(
  dashboardStateLayer: Layer.Layer<StartDashboardState>,
): StartDashboardModel {
  const runtime = Atom.context({ memoMap: Layer.makeMemoMapUnsafe() })(dashboardStateLayer);
  const serviceStatesStateAtom = runtime.subscriptionRef(
    StartDashboardState.use((state) => Effect.succeed(state.serviceStatesRef)),
  );
  const stackInfoStateAtom = runtime.subscriptionRef(
    StartDashboardState.use((state) => Effect.succeed(state.stackInfoRef)),
  );
  const phaseStateAtom = runtime.subscriptionRef(
    StartDashboardState.use((state) => Effect.succeed(state.phaseRef)),
  );
  const errorStateAtom = runtime.subscriptionRef(
    StartDashboardState.use((state) => Effect.succeed(state.errorRef)),
  );

  const serviceStatesAtom = fromResultAtom(serviceStatesStateAtom, []);
  const stackInfoAtom = fromResultAtom(stackInfoStateAtom, null);
  const phaseAtom = fromResultAtom(phaseStateAtom, "starting");
  const errorAtom = fromResultAtom(errorStateAtom, null);
  const displayStatesAtom = Atom.make((get) => toDisplayStates(get(serviceStatesAtom)));
  const allHealthyAtom = Atom.make(
    (get) =>
      get(displayStatesAtom).length > 0 &&
      get(displayStatesAtom).every((s) => s.status === "Healthy"),
  );
  const statusLineAtom = Atom.make((get) => {
    const phase = get(phaseAtom);
    const error = get(errorAtom);

    switch (phase) {
      case "failed":
        return `❌ ${error ?? "Startup failed"}`;
      case "stopping":
        return "⏳ Stopping...";
      case "running":
        return "🟢 Running — Interrupt to stop (usually Ctrl+C)";
      case "starting":
        return get(allHealthyAtom)
          ? "🟢 Running — Interrupt to stop (usually Ctrl+C)"
          : "⏳ Starting...";
    }
  });

  return {
    serviceStatesStateAtom,
    stackInfoStateAtom,
    phaseStateAtom,
    errorStateAtom,
    serviceStatesAtom,
    stackInfoAtom,
    phaseAtom,
    errorAtom,
    displayStatesAtom,
    allHealthyAtom,
    statusLineAtom,
  };
}
