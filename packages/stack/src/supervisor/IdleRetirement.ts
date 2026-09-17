import { Duration, Effect, FiberMap } from "effect";
import type { ServiceInstanceId } from "../public/ServiceInstanceId.ts";

export interface IdleRetirement {
  /** Arms or replaces the idle timer for one registered instance. */
  readonly arm: (id: ServiceInstanceId, generation: number, seconds: number) => Effect.Effect<void>;
  /** Cancels the idle timer for one registered instance. */
  readonly cancel: (id: ServiceInstanceId) => Effect.Effect<void>;
}

/** Owns scoped per-instance idle timers and invokes the engine's retirement callback. */
export const makeIdleRetirement = (
  retire: (id: ServiceInstanceId, generation: number) => Effect.Effect<void>,
): Effect.Effect<IdleRetirement, never, import("effect").Scope.Scope> =>
  Effect.gen(function* () {
    const timers = yield* FiberMap.make<ServiceInstanceId>();
    return {
      arm: (id, generation, seconds) =>
        !Number.isFinite(seconds) || seconds <= 0
          ? FiberMap.remove(timers, id)
          : FiberMap.run(
              timers,
              id,
            )(
              Effect.sleep(Duration.seconds(seconds)).pipe(Effect.andThen(retire(id, generation))),
            ).pipe(Effect.asVoid),
      cancel: (id) => FiberMap.remove(timers, id),
    } satisfies IdleRetirement;
  });
