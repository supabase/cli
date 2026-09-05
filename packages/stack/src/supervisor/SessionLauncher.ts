import { Cause, Effect, Exit, Ref } from "effect";
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
  /** Starts the supplied dependency closure in dependency-ready waves. */
  readonly launch: (plan: ExecutionPlan) => Effect.Effect<SessionLaunch, RuntimeDriverError>;
  /** Stops and removes every workload started in this session in reverse order. */
  readonly stop: Effect.Effect<void, RuntimeDriverError>;
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

/**
 * Owns only the workloads started by the current Supervisor session. A launch starts
 * dependency-ready waves and a failure cleans that attempt's resources.
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
        let remaining = planEntries.filter((entry) => !ready.has(entry.workload.id));
        let outcome: Exit.Exit<void, RuntimeDriverError> = Exit.succeed(undefined);
        while (remaining.length > 0 && Exit.isSuccess(outcome)) {
          const wave = remaining.filter((entry) =>
            entry.workload.dependencies.every((dependency) => ready.has(dependency)),
          );
          if (wave.length === 0) {
            outcome = Exit.fail(
              new RuntimeDriverError({
                message: "No workload is ready to start; dependencies are unsatisfied",
                stackId: options.stackId,
              }),
            );
            break;
          }
          outcome = yield* Effect.exit(
            Effect.forEach(
              wave,
              (entry) =>
                Effect.gen(function* () {
                  // Record the resource immediately before starting it. This includes an
                  // in-flight start when a sibling fails, without treating queued work as owned.
                  attempted.push(entry);
                  yield* options.driver.start(entry.key, entry.workload);
                }),
              { concurrency: START_CONCURRENCY, discard: true },
            ),
          );
          if (Exit.isSuccess(outcome)) {
            for (const entry of wave) ready.add(entry.workload.id);
            yield* Ref.update(session, (current) => [...current, ...wave]);
            remaining = remaining.filter((entry) => !ready.has(entry.workload.id));
          }
        }
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
    return {
      launch,
      stop,
      cleanupProven: Ref.get(cleanupProven),
      clear: Ref.set(session, []),
    } satisfies SessionLauncher;
  });
