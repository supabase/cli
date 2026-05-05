import { clearTimeout, setTimeout } from "node:timers";
import { createElement } from "react";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { Cause, Effect, Layer } from "effect";
import { RegistryContext } from "@effect/atom-react";
import { Stack } from "@supabase/stack/effect";
import { Ink } from "../../../../shared/runtime/ink.service.ts";
import { StartDashboardState } from "./dashboard-state.ts";
import { StartDashboard } from "./StartDashboard.tsx";
import { createStartDashboardModel } from "./dashboard.model.ts";

interface StartForegroundSession {
  readonly waitUntilExit: Effect.Effect<void>;
  readonly markRunning: Effect.Effect<void>;
  readonly markStopping: Effect.Effect<void>;
  readonly markFailed: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
}

function scheduleTask(f: () => void) {
  const id = setTimeout(f, 0);
  return () => clearTimeout(id);
}

export const makeStartForegroundSession = Effect.fnUntraced(function* () {
  const stack = yield* Stack;
  const ink = yield* Ink;
  const registry = AtomRegistry.make({ scheduleTask });
  const model = createStartDashboardModel(
    Layer.provide(StartDashboardState.live, Layer.succeed(Stack, stack)),
  );

  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));

  yield* Effect.acquireRelease(
    Effect.sync(() => [
      registry.mount(model.stackInfoStateAtom),
      registry.mount(model.serviceStatesStateAtom),
      registry.mount(model.phaseStateAtom),
      registry.mount(model.errorStateAtom),
    ]),
    (releases) =>
      Effect.sync(() => {
        for (const release of releases) {
          release();
        }
      }),
  );

  const instance = yield* Effect.acquireRelease(
    ink.render(
      createElement(
        RegistryContext.Provider,
        { value: registry },
        createElement(StartDashboard, { model }),
      ),
    ),
    (instance) => Effect.sync(() => instance.unmount()),
  );

  const setPhase = (phase: "running" | "stopping" | "failed") =>
    Effect.sync(() => {
      registry.set(model.phaseStateAtom, phase);
    });

  return {
    waitUntilExit: Effect.promise(() => instance.waitUntilExit()).pipe(Effect.orDie, Effect.asVoid),
    markRunning: setPhase("running"),
    markStopping: setPhase("stopping"),
    markFailed: (cause) =>
      Effect.sync(() => {
        registry.set(model.errorStateAtom, Cause.pretty(cause));
        registry.set(model.phaseStateAtom, "failed");
      }),
  } satisfies StartForegroundSession;
});
