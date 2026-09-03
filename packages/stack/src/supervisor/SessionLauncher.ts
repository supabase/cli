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
  /** Starts the supplied dependency closure in topological order. */
  readonly launch: (plan: ExecutionPlan) => Effect.Effect<void, RuntimeDriverError>;
  /** Stops and removes every workload started in this session in reverse order. */
  readonly stop: Effect.Effect<void, RuntimeDriverError>;
  /** Clears the session after stack-wide runtime cleanup has completed. */
  readonly clear: Effect.Effect<void>;
}

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
 * Owns only the workloads started by the current Supervisor session. A launch is one ordered
 * attempt and a failure cleans that attempt's resources.
 */
export const makeSessionLauncher = (options: {
  readonly stackId: StackId;
  readonly driver: RuntimeDriver;
}): Effect.Effect<SessionLauncher> =>
  Effect.gen(function* () {
    const session = yield* Ref.make<ReadonlyArray<SessionWorkload>>([]);

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

    const launch = (plan: ExecutionPlan): Effect.Effect<void, RuntimeDriverError> =>
      Effect.gen(function* () {
        const existing = new Set((yield* Ref.get(session)).map(({ key }) => key.workloadId));
        const attempted: SessionWorkload[] = [];
        const outcome = yield* Effect.exit(
          Effect.forEach(
            plan.workloads,
            (workload) =>
              Effect.gen(function* () {
                if (existing.has(workload.id)) return;
                const entry = { key: keyFor(options.stackId, workload), workload };
                attempted.push(entry);
                yield* options.driver.start(entry.key, workload);
                yield* Ref.update(session, (current) => [...current, entry]);
              }),
            { concurrency: 1, discard: true },
          ),
        );
        if (Exit.isSuccess(outcome)) return;
        const cleaned = yield* cleanup(attempted).pipe(Effect.exit);
        if (Exit.isFailure(cleaned))
          return yield* Effect.failCause(combine(outcome.cause, cleaned.cause));
        return yield* Effect.failCause(outcome.cause);
      });

    const stop = Effect.suspend(() => Ref.get(session).pipe(Effect.flatMap(cleanup)));
    return {
      launch,
      stop,
      clear: Ref.set(session, []),
    } satisfies SessionLauncher;
  });
