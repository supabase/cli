import { Cause, Data, Deferred, Effect, Exit, Match, Ref, Semaphore } from "effect";
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

/** A cleanup failure retains ownership because at least one remove was unproven. */
export class SessionCleanupError extends Data.TaggedError("SessionCleanupError")<{
  readonly cause: Cause.Cause<RuntimeDriverError | SessionCleanupError>;
}> {}

export interface SessionLauncher {
  /** Starts the supplied dependency closure as dependencies complete. */
  readonly launch: (
    plan: ExecutionPlan,
    cancellation?: Deferred.Deferred<void, never>,
  ) => Effect.Effect<SessionLaunchOutcome>;
  /** Stops and removes every workload started in this session in reverse order. */
  readonly stop: Effect.Effect<void, RuntimeDriverError | SessionCleanupError>;
  readonly stopCapabilities: (
    capabilities: ReadonlySet<import("../public/Capability.ts").CapabilityName>,
  ) => Effect.Effect<void, RuntimeDriverError | SessionCleanupError>;
  /** Clears the session after stack-wide runtime cleanup has completed. */
  readonly clear: Effect.Effect<void>;
}

/** Resources created by one launch attempt and a rollback scoped to that attempt. */
interface SessionLaunch {
  readonly rollback: Effect.Effect<SessionCleanupOutcome>;
}

export type SessionCleanupOutcome =
  | { readonly _tag: "proven" }
  | {
      readonly _tag: "unproven";
      readonly cause: Cause.Cause<RuntimeDriverError | SessionCleanupError>;
    };

export type SessionLaunchOutcome =
  | { readonly _tag: "started"; readonly launch: SessionLaunch }
  | {
      readonly _tag: "failed";
      readonly cause: Cause.Cause<RuntimeDriverError | SessionCleanupError>;
      readonly cleanup: SessionCleanupOutcome;
    };

const START_CONCURRENCY = 4;

const keyFor = (stackId: StackId, workload: PlannedWorkload): RuntimeWorkloadKey => ({
  stackId,
  workloadId: workload.id,
});

type SessionError = RuntimeDriverError | SessionCleanupError;

const combine = (
  primary: Cause.Cause<SessionError>,
  cleanup: Cause.Cause<SessionError>,
): Cause.Cause<SessionError> =>
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
    const cleanup = (
      entries: ReadonlyArray<SessionWorkload>,
    ): Effect.Effect<SessionCleanupOutcome> =>
      Effect.gen(function* () {
        let cleanupCause: Cause.Cause<SessionError> = Cause.empty;
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
        return cleanupCause.reasons.length === 0
          ? ({ _tag: "proven" } satisfies SessionCleanupOutcome)
          : ({ _tag: "unproven", cause: cleanupCause } satisfies SessionCleanupOutcome);
      });

    const launch = (
      plan: ExecutionPlan,
      cancellation?: Deferred.Deferred<void, never>,
    ): Effect.Effect<SessionLaunchOutcome> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const cancel = cancellation ?? (yield* Deferred.make<void>());
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
              const cleaned = yield* cleanup(attempted);
              return {
                _tag: "failed",
                cause: Match.value(cleaned).pipe(
                  Match.when({ _tag: "unproven" }, (value) =>
                    combine(Cause.fail(failure), value.cause),
                  ),
                  Match.when({ _tag: "proven" }, () => Cause.fail(failure)),
                  Match.exhaustive,
                ),
                cleanup: cleaned,
              } satisfies SessionLaunchOutcome;
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
                  // Record before entering the driver: a driver may acquire a resource and then
                  // fail or be interrupted before its start effect returns.
                  attempted.push(entry);
                  yield* Ref.update(session, (current) =>
                    current.some((candidate) => candidate.key.workloadId === entry.key.workloadId)
                      ? current
                      : [...current, entry],
                  );
                  yield* options.driver.start(entry.key, entry.workload);
                }),
              );
            });
            const cancelled = Deferred.await(cancel).pipe(
              Effect.andThen(
                Effect.fail(
                  new RuntimeDriverError({
                    message: "Launch cancelled while another lifecycle prerequisite failed",
                    stackId: options.stackId,
                    workloadId: entry.workload.id,
                  }),
                ),
              ),
            );
            const completion = completions.get(entry.workload.id);
            return Effect.raceFirst(startBody, cancelled).pipe(
              Effect.onExit((result) =>
                completion === undefined ? Effect.void : Deferred.succeed(completion, result),
              ),
            );
          };
          const outcome = yield* Effect.exit(
            restore(
              Effect.forEach(remaining, startOne, { concurrency: "unbounded", discard: true }),
            ),
          );
          if (Exit.isSuccess(outcome)) {
            return {
              _tag: "started",
              launch: { rollback: cleanup(attempted) },
            } satisfies SessionLaunchOutcome;
          }
          const cleaned = yield* cleanup(attempted);
          return {
            _tag: "failed",
            cause: Match.value(cleaned).pipe(
              Match.when({ _tag: "unproven" }, (value) => combine(outcome.cause, value.cause)),
              Match.when({ _tag: "proven" }, () => outcome.cause),
              Match.exhaustive,
            ),
            cleanup: cleaned,
          } satisfies SessionLaunchOutcome;
        }),
      );
    const cleanupOrFail = (entries: ReadonlyArray<SessionWorkload>) =>
      cleanup(entries).pipe(
        Effect.flatMap((outcome) =>
          Match.value(outcome).pipe(
            Match.when({ _tag: "proven" }, () => Effect.void),
            Match.when({ _tag: "unproven" }, (value) =>
              Effect.fail(new SessionCleanupError({ cause: value.cause })),
            ),
            Match.exhaustive,
          ),
        ),
      );
    const stop = Effect.suspend(() => Ref.get(session).pipe(Effect.flatMap(cleanupOrFail)));
    const stopCapabilities = (
      capabilities: ReadonlySet<import("../public/Capability.ts").CapabilityName>,
    ) =>
      Ref.get(session).pipe(
        Effect.flatMap((entries) =>
          cleanupOrFail(entries.filter(({ workload }) => capabilities.has(workload.capability))),
        ),
      );
    return {
      launch,
      stop,
      stopCapabilities,
      clear: Ref.set(session, []),
    } satisfies SessionLauncher;
  });
