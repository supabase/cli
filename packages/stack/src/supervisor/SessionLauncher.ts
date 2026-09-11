import { Cause, Deferred, Effect, Exit, Ref, Semaphore } from "effect";
import type { ExecutionPlan, PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { StackId } from "../public/StackId.ts";
import {
  RuntimeDriverError,
  type RuntimeDriver,
  type RuntimeWorkloadKey,
} from "../runtime/RuntimeDriver.ts";

interface SessionWorkload {
  readonly key: RuntimeWorkloadKey;
  readonly workload: PlannedWorkload;
}

export interface SessionLauncher {
  /** Starts the supplied dependency closure as dependencies complete. */
  readonly launch: (plan: ExecutionPlan) => Effect.Effect<SessionLaunch, RuntimeDriverError>;
  /** Stops and removes every workload started in this session in reverse order. */
  readonly stop: Effect.Effect<void, RuntimeDriverError>;
  readonly stopCapabilities: (
    capabilities: ReadonlySet<import("../public/Capability.ts").CapabilityName>,
  ) => Effect.Effect<void, RuntimeDriverError>;
  /** Whether the most recent launch/rollback cleanup completed exactly. */
  readonly cleanupProven: Effect.Effect<boolean>;
  /** Clears the session after stack-wide runtime cleanup has completed. */
  readonly clear: Effect.Effect<void>;
}

/** Resources created by one launch attempt and a rollback scoped to that attempt. */
interface SessionLaunch {
  readonly rollback: Effect.Effect<void, RuntimeDriverError>;
}

const START_CONCURRENCY = 4;

const keyFor = (stackId: StackId, workload: PlannedWorkload): RuntimeWorkloadKey => ({
  stackId,
  workloadId: workload.id,
});

const combine = (
  primary: Cause.Cause<RuntimeDriverError>,
  cleanup: Cause.Cause<RuntimeDriverError>,
): Cause.Cause<RuntimeDriverError> =>
  cleanup.reasons.length === 0 ? primary : Cause.combine(primary, cleanup);

const joinExit = <A, E>(result: Exit.Exit<A, E>): Effect.Effect<A, E> =>
  Exit.isSuccess(result) ? Effect.succeed(result.value) : Effect.failCause(result.cause);

/**
 * Owns only the workloads started by the current Supervisor session. A launch starts
 * dependency-ready workloads as soon as their prerequisites complete and a failure cleans
 * that attempt's resources.
 */
export const makeSessionLauncher = (options: {
  readonly stackId: StackId;
  readonly driver: RuntimeDriver;
}): Effect.Effect<SessionLauncher> =>
  Effect.gen(function* () {
    const session = yield* Ref.make<ReadonlyArray<SessionWorkload>>([]);
    const cleanupProven = yield* Ref.make(true);

    const cleanup = (
      entries: ReadonlyArray<SessionWorkload>,
    ): Effect.Effect<void, RuntimeDriverError> =>
      Effect.gen(function* () {
        let cleanupCause: Cause.Cause<RuntimeDriverError> = Cause.empty;
        for (const entry of [...entries].reverse()) {
          const stopped = yield* Effect.exit(options.driver.stop(entry.key));
          if (Exit.isFailure(stopped)) cleanupCause = combine(cleanupCause, stopped.cause);
          const removed = yield* Effect.exit(options.driver.remove(entry.key));
          if (Exit.isFailure(removed)) cleanupCause = combine(cleanupCause, removed.cause);
          else
            yield* Ref.update(session, (current) =>
              current.filter((candidate) => candidate.key.workloadId !== entry.key.workloadId),
            );
        }
        if (cleanupCause.reasons.length > 0) return yield* Effect.failCause(cleanupCause);
      });

    const launch = (plan: ExecutionPlan): Effect.Effect<SessionLaunch, RuntimeDriverError> =>
      Effect.gen(function* () {
        yield* Ref.set(cleanupProven, true);
        const attempted: SessionWorkload[] = [];
        const planEntries = plan.workloads.map((workload) => ({
          key: keyFor(options.stackId, workload),
          workload,
        }));
        const ready = new Set((yield* Ref.get(session)).map(({ key }) => key.workloadId));
        const remaining = planEntries.filter((entry) => !ready.has(entry.workload.id));
        const unresolved = new Set(remaining.map((entry) => entry.workload.id));
        const graphReady = new Set(ready);
        // Reject cycles before creating fibers that would otherwise wait forever.
        while (unresolved.size > 0) {
          const completed = [...unresolved].filter((id) => {
            const entry = planEntries.find((candidate) => candidate.workload.id === id);
            return (
              entry !== undefined &&
              entry.workload.dependencies.every((dependency) => graphReady.has(dependency))
            );
          });
          if (completed.length === 0) {
            const failure = new RuntimeDriverError({
              message: "No workload is ready to start; dependencies are unsatisfied",
              stackId: options.stackId,
            });
            const cleaned = yield* cleanup(attempted).pipe(Effect.exit);
            yield* Ref.set(cleanupProven, Exit.isSuccess(cleaned));
            if (Exit.isFailure(cleaned))
              return yield* Effect.failCause(combine(Cause.fail(failure), cleaned.cause));
            return yield* failure;
          }
          completed.forEach((id) => unresolved.delete(id));
          completed.forEach((id) => graphReady.add(id));
        }
        const startPermit = yield* Semaphore.make(START_CONCURRENCY);
        const completions = new Map<
          string,
          Deferred.Deferred<Exit.Exit<void, RuntimeDriverError>, never>
        >();
        for (const entry of remaining)
          completions.set(
            entry.workload.id,
            yield* Deferred.make<Exit.Exit<void, RuntimeDriverError>>(),
          );
        const startOne = (entry: SessionWorkload): Effect.Effect<void, RuntimeDriverError> => {
          const startBody = Effect.gen(function* () {
            yield* Effect.forEach(
              entry.workload.dependencies,
              (dependency) => {
                if (ready.has(dependency)) return Effect.void;
                const completion = completions.get(dependency);
                if (completion === undefined)
                  return Effect.fail(
                    new RuntimeDriverError({
                      message: `Dependency ${dependency} is not part of the launch plan`,
                      stackId: options.stackId,
                      workloadId: entry.workload.id,
                    }),
                  );
                return Deferred.await(completion).pipe(Effect.flatMap(joinExit));
              },
              { discard: true },
            );
            yield* startPermit.withPermit(
              Effect.gen(function* () {
                // Record only once a start permit is held: queued dependency work is not owned.
                attempted.push(entry);
                yield* options.driver.start(entry.key, entry.workload);
              }),
            );
            yield* Ref.update(session, (current) => [...current, entry]);
          });
          return Effect.gen(function* () {
            const result = yield* Effect.exit(startBody);
            const completion = completions.get(entry.workload.id);
            if (completion !== undefined) yield* Deferred.succeed(completion, result);
            return yield* joinExit(result);
          });
        };
        const outcome = yield* Effect.exit(
          Effect.forEach(remaining, startOne, { concurrency: "unbounded", discard: true }),
        );
        if (Exit.isSuccess(outcome)) {
          const rollback = Effect.gen(function* () {
            const result = yield* cleanup(attempted).pipe(Effect.exit);
            yield* Ref.set(cleanupProven, Exit.isSuccess(result));
            // A failed rollback is not a reusable session workload. The exact runtime cleanup
            // boundary remains responsible for retrying any resource whose remove failed.
            yield* Ref.update(session, (current) =>
              current.filter(
                (candidate) =>
                  !attempted.some((entry) => entry.key.workloadId === candidate.key.workloadId),
              ),
            );
            if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
          });
          return { rollback } satisfies SessionLaunch;
        }
        const cleaned = yield* cleanup(attempted).pipe(Effect.exit);
        yield* Ref.set(cleanupProven, Exit.isSuccess(cleaned));
        // Failed launch entries are never reusable. Exact stack cleanup will retry any resource
        // whose stop/remove failed, while a later activation must attempt a fresh start.
        yield* Ref.update(session, (current) =>
          current.filter(
            (candidate) =>
              !attempted.some((entry) => entry.key.workloadId === candidate.key.workloadId),
          ),
        );
        if (Exit.isFailure(cleaned))
          return yield* Effect.failCause(combine(outcome.cause, cleaned.cause));
        return yield* Effect.failCause(outcome.cause);
      });

    const stop = Effect.suspend(() => Ref.get(session).pipe(Effect.flatMap(cleanup)));
    const stopCapabilities = (
      capabilities: ReadonlySet<import("../public/Capability.ts").CapabilityName>,
    ) =>
      Ref.get(session).pipe(
        Effect.flatMap((entries) =>
          cleanup(entries.filter(({ workload }) => capabilities.has(workload.capability))),
        ),
      );
    return {
      launch,
      stop,
      stopCapabilities,
      cleanupProven: Ref.get(cleanupProven),
      clear: Ref.set(session, []),
    } satisfies SessionLauncher;
  });
