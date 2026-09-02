import { Cause, Effect, Exit, Option, Schedule, Semaphore } from "effect";
import type { ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { StackId } from "../public/StackId.ts";
import {
  planDesiredState,
  type DesiredLifecycle,
  type ReconciliationInput,
} from "./DesiredState.ts";
import {
  RuntimeDriverError,
  RuntimeRestartBudgetExceededError,
  type ObservedWorkload,
  type RuntimeDriver,
} from "../runtime/RuntimeDriver.ts";

interface ReconcilerRequest {
  readonly stackId: StackId;
  readonly desiredLifecycle: DesiredLifecycle;
  readonly plan: ExecutionPlan;
}

export interface ReconcilerOptions {
  readonly driver: RuntimeDriver;
}

interface ReconciliationResult {
  readonly observed: ReadonlyArray<ObservedWorkload>;
  readonly started: ReadonlyArray<string>;
  readonly stopped: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{
    readonly workloadId: string;
    readonly error: RuntimeDriverError | RuntimeRestartBudgetExceededError;
  }>;
  readonly blocked: ReadonlyArray<{ readonly workloadId: string; readonly dependencyId: string }>;
}

export interface Reconciler {
  readonly reconcile: (
    request: ReconcilerRequest,
  ) => Effect.Effect<ReconciliationResult, ReconcilerError>;
}

type ReconcilerError = RuntimeDriverError | RuntimeRestartBudgetExceededError;

type AttemptFailure = RuntimeDriverError;

/** Internal retry sentinel that keeps the complete failed attempt Cause intact. */
class RuntimeAttemptControlError extends RuntimeDriverError {
  readonly originalCause: Cause.Cause<AttemptFailure>;
  readonly retryable: boolean;

  constructor(cause: Cause.Cause<AttemptFailure>, retryable: boolean) {
    super({ message: "runtime start attempt failed" });
    this.originalCause = cause;
    this.retryable = retryable;
  }
}

/**
 * Creates a Supervisor-local reconciler. The semaphore serializes every lifecycle mutation. The
 * Supervisor is responsible for forking this effect in its owner Scope; callers waiting on an RPC
 * must not become lifecycle owners or cancel the owner-managed operation.
 */
export const makeReconciler = (options: ReconcilerOptions): Effect.Effect<Reconciler> =>
  Effect.gen(function* () {
    const lifecycle = yield* Semaphore.make(1);
    // Restart budgets are Supervisor-local and reset when lifecycle enters stopped.
    const restartAttempts = new Map<string, number>();

    const reconcile = (
      request: ReconcilerRequest,
    ): Effect.Effect<ReconciliationResult, ReconcilerError> =>
      lifecycle.withPermit(
        Effect.gen(function* () {
          if (request.desiredLifecycle !== "running") {
            const prefix = `${request.stackId}:`;
            for (const key of restartAttempts.keys())
              if (key.startsWith(prefix)) restartAttempts.delete(key);
          }
          const observed = yield* options.driver.observe(request.stackId);
          const desired: ReconciliationInput = { ...request, observed };
          const delta = planDesiredState(desired);
          const failed: Array<ReconciliationResult["failed"][number]> = [];
          const started: string[] = [];
          const stopped: string[] = [];
          const removed: string[] = [];
          const failedIds = new Set<string>();
          const blocked = [...delta.blocked];
          const addBlocked = (workloadId: string, dependencyId: string) => {
            if (!blocked.some((entry) => entry.workloadId === workloadId))
              blocked.push({ workloadId, dependencyId });
          };

          const runMutation = <A, E>(
            effect: Effect.Effect<A, E>,
          ): Effect.Effect<A, E | RuntimeDriverError> =>
            Effect.gen(function* () {
              const result = yield* effect.pipe(Effect.exit);
              if (Exit.isSuccess(result)) return result.value;
              return yield* Effect.failCause(result.cause);
            });

          const quiesceDependents = () =>
            Effect.gen(function* () {
              const current = yield* options.driver.observe(request.stackId);
              const affected: Array<{
                readonly workload: (typeof request.plan.workloads)[number];
                readonly dependencyId: string;
              }> = [];
              // First compute the complete transitive closure in topological order. A reverse pass
              // alone would visit leaf before its parent had been marked failed.
              for (const workload of request.plan.workloads) {
                const dependencyFailure = workload.dependencies.find((dependency) =>
                  failedIds.has(dependency),
                );
                if (dependencyFailure === undefined) continue;
                failedIds.add(workload.id);
                addBlocked(workload.id, dependencyFailure);
                affected.push({ workload, dependencyId: dependencyFailure });
              }
              // Stop and remove affected resources in reverse topological order.
              for (const { workload } of affected.reverse()) {
                const observed = current.find(({ workloadId }) => workloadId === workload.id);
                if (
                  observed === undefined ||
                  (observed.state !== "ready" && observed.state !== "starting")
                )
                  continue;
                const key = {
                  stackId: request.stackId,
                  workloadId: observed.workloadId,
                  specHash: observed.specHash,
                };
                yield* runMutation(options.driver.stop(key));
                stopped.push(key.workloadId);
                yield* runMutation(options.driver.remove(key));
                removed.push(key.workloadId);
              }
            });

          for (const action of delta.stops) {
            yield* runMutation(options.driver.stop(action.key));
            stopped.push(action.key.workloadId);
          }
          for (const action of delta.removes) {
            const observedEntry = observed.find(
              (entry) =>
                entry.stackId === action.key.stackId &&
                entry.workloadId === action.key.workloadId &&
                entry.specHash === action.key.specHash,
            );
            const workload = request.plan.workloads.find(({ id }) => id === action.key.workloadId);
            const budgetKey = `${request.stackId}:${action.key.workloadId}`;
            const attempts = restartAttempts.get(budgetKey);
            const preserveExhaustedFailure =
              observedEntry?.state === "failed" &&
              workload !== undefined &&
              attempts !== undefined &&
              attempts >= Math.max(1, workload.restart.maxAttempts);
            // Keep a terminal failed resource visible to status. Removing it would make an
            // exhausted post-readiness crash look dormant/stopped and lose the diagnostic error.
            if (preserveExhaustedFailure) continue;
            yield* runMutation(options.driver.remove(action.key));
            removed.push(action.key.workloadId);
          }

          for (const action of delta.starts) {
            const dependencyFailure = action.workload.dependencies.find((dependency) =>
              failedIds.has(dependency),
            );
            if (dependencyFailure !== undefined) {
              failedIds.add(action.workload.id);
              addBlocked(action.workload.id, dependencyFailure);
              continue;
            }
            const maxAttempts = Math.max(1, action.workload.restart.maxAttempts);
            const budgetKey = `${request.stackId}:${action.workload.id}`;
            const previousAttempts = restartAttempts.get(budgetKey);
            if (previousAttempts !== undefined && previousAttempts >= maxAttempts) {
              failedIds.add(action.workload.id);
              failed.push({
                workloadId: action.workload.id,
                error: new RuntimeRestartBudgetExceededError({
                  message: `Restart budget exhausted for ${action.workload.id}`,
                  stackId: request.stackId,
                  workloadId: action.workload.id,
                  attempts: previousAttempts,
                }),
              });
              yield* quiesceDependents();
              continue;
            }
            const hadReadyFailure = observed.some(
              (entry) =>
                entry.workloadId === action.workload.id &&
                entry.specHash === action.workload.specHash &&
                entry.state === "failed",
            );
            if (hadReadyFailure) {
              const attempts = restartAttempts.get(budgetKey) ?? 0;
              if (attempts >= maxAttempts) {
                restartAttempts.set(budgetKey, attempts);
                failedIds.add(action.workload.id);
                failed.push({
                  workloadId: action.workload.id,
                  error: new RuntimeRestartBudgetExceededError({
                    message: `Restart budget exhausted for ${action.workload.id}`,
                    stackId: request.stackId,
                    workloadId: action.workload.id,
                    attempts,
                  }),
                });
                yield* quiesceDependents();
                continue;
              }
              restartAttempts.set(budgetKey, attempts + 1);
            }
            const attempt = options.driver.start(action.key, action.workload);
            const schedule: Schedule.Schedule<unknown, RuntimeAttemptControlError> =
              Schedule.exponential(`${Math.max(0, action.workload.restart.backoffMs)} millis`).pipe(
                Schedule.upTo({ times: Math.max(0, maxAttempts - 1) }),
              );
            const attempted: Effect.Effect<ObservedWorkload, RuntimeAttemptControlError> =
              runMutation(attempt).pipe(
                Effect.catchCause((cause: Cause.Cause<AttemptFailure>) => {
                  const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined;
                  const failure =
                    reason !== undefined && Cause.isFailReason(reason) ? reason.error : undefined;
                  const retryable = failure !== undefined;
                  return Effect.fail(new RuntimeAttemptControlError(cause, retryable));
                }),
              );
            const retryOptions: Effect.Retry.Options<RuntimeAttemptControlError> = {
              schedule,
              while: (error) => error.retryable,
            };
            const outcome: Exit.Exit<ObservedWorkload, RuntimeAttemptControlError> =
              yield* Effect.exit(Effect.retry(attempted, retryOptions));
            if (Exit.isSuccess(outcome)) {
              started.push(action.workload.id);
              continue;
            }
            // A mixed Cause is not a retryable typed failure: preserving the complete Cause keeps
            // defects and interruption visible to the Supervisor instead of turning them into a
            // misleading budget-exhaustion status.
            const maybeError = Cause.findErrorOption(outcome.cause);
            if (Option.isNone(maybeError)) return yield* Effect.failCause(outcome.cause);
            const error = maybeError.value;
            if (Cause.hasDies(error.originalCause) || Cause.hasInterrupts(error.originalCause))
              return yield* Effect.failCause(error.originalCause);
            const original = Cause.findErrorOption(error.originalCause);
            if (Option.isNone(original)) return yield* Effect.failCause(error.originalCause);
            failedIds.add(action.workload.id);
            restartAttempts.set(budgetKey, maxAttempts);
            failed.push({ workloadId: action.workload.id, error: original.value });
            yield* quiesceDependents();
          }

          const current = yield* options.driver.observe(request.stackId);
          return {
            observed: current,
            started,
            stopped,
            removed,
            failed,
            blocked,
          };
        }),
      );

    return { reconcile };
  });
