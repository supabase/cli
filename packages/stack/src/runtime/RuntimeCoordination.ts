import { Effect, Option, Semaphore } from "effect";
import type { RuntimeWorkloadKey } from "./RuntimeDriver.ts";

/** Coordinates exact runtime workloads without serializing unrelated slow operations. */
export interface RuntimeCoordination {
  /** Runs an operation under the exact workload's exclusion fence. */
  readonly withKey: <A, E, R>(
    key: RuntimeWorkloadKey,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Commits a short registration/publication section unless its stack is fenced. */
  readonly withKeyCommit: <A, E, R>(
    key: RuntimeWorkloadKey,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  /** Runs a short publication section under map admission without acquiring a workload lock. */
  readonly withMapCommit: <A, E, R>(
    stackId: RuntimeWorkloadKey["stackId"],
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  /** Serializes cleanup executions for one stack while leaving other stacks independent. */
  readonly withStackCleanup: <A, E, R>(
    stackId: RuntimeWorkloadKey["stackId"],
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

const keyFor = (key: RuntimeWorkloadKey): string =>
  JSON.stringify([key.stackId, key.instanceId, key.workloadId]);

/** Creates runtime coordination with short map admission and one mutex per exact workload. */
export const makeRuntimeCoordination: Effect.Effect<RuntimeCoordination> = Effect.suspend(() =>
  Effect.gen(function* () {
    const mapAdmission = yield* Semaphore.make(1);
    const workloadLocks = new Map<string, Semaphore.Semaphore>();
    const stackCleanupLocks = new Map<RuntimeWorkloadKey["stackId"], Semaphore.Semaphore>();
    const fencedStacks = new Set<RuntimeWorkloadKey["stackId"]>();

    const lockFor = (key: RuntimeWorkloadKey): Effect.Effect<Semaphore.Semaphore> =>
      mapAdmission.withPermit(
        Effect.sync(() => {
          const id = keyFor(key);
          const existing = workloadLocks.get(id);
          if (existing !== undefined) return existing;
          const created = Semaphore.makeUnsafe(1);
          workloadLocks.set(id, created);
          return created;
        }),
      );
    const cleanupLockFor = (
      stackId: RuntimeWorkloadKey["stackId"],
    ): Effect.Effect<Semaphore.Semaphore> =>
      mapAdmission.withPermit(
        Effect.sync(() => {
          const existing = stackCleanupLocks.get(stackId);
          if (existing !== undefined) return existing;
          const created = Semaphore.makeUnsafe(1);
          stackCleanupLocks.set(stackId, created);
          return created;
        }),
      );

    const withMapCommit = <A, E, R>(
      stackId: RuntimeWorkloadKey["stackId"],
      operation: Effect.Effect<A, E, R>,
    ): Effect.Effect<Option.Option<A>, E, R> =>
      mapAdmission.withPermit(
        Effect.gen(function* () {
          if (fencedStacks.has(stackId)) return Option.none();
          return Option.some(yield* operation);
        }),
      );

    return {
      withKey: (key, operation) =>
        Effect.flatMap(lockFor(key), (lock) => lock.withPermit(operation)),
      withKeyCommit: (key, operation) =>
        Effect.flatMap(lockFor(key), (lock) =>
          lock.withPermit(withMapCommit(key.stackId, operation)),
        ),
      withMapCommit,
      withStackCleanup: (stackId, operation) =>
        Effect.flatMap(cleanupLockFor(stackId), (lock) =>
          lock.withPermit(
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                yield* mapAdmission.withPermit(
                  Effect.sync(() => {
                    fencedStacks.add(stackId);
                  }),
                );
                return yield* restore(operation).pipe(
                  Effect.ensuring(
                    mapAdmission.withPermit(
                      Effect.sync(() => {
                        fencedStacks.delete(stackId);
                      }),
                    ),
                  ),
                );
              }),
            ),
          ),
        ),
    } satisfies RuntimeCoordination;
  }),
);
