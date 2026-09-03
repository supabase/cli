import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  FiberSet,
  Option,
  Path,
  Predicate,
  Redacted,
  Ref,
  Semaphore,
  Scope,
} from "effect";
import { rebuildExecutionPlan } from "../model/Compiler.ts";
import {
  activeExecutionPlan,
  dependencyClosure,
  eagerCapabilities,
  type ExecutionPlan,
} from "../model/ExecutionPlan.ts";
import type { CapabilityName } from "../public/Capability.ts";
import type { StackConfig } from "../public/Config.ts";
import {
  GatewayActivationError,
  ContainerEngineError,
  InvalidLogCursorError,
  StackLifecycleConflictError,
  StackNotRunningError,
  StackRuntimeError,
  StackCleanupError,
  StackStateInvalidError,
  isStackError,
  isStackErrorTag,
  type StackErrorTag,
  type StackError,
} from "../public/Errors.ts";
import type { StackStatus } from "../public/Status.ts";
import type { StackId } from "../public/StackId.ts";
import type { LogQuery, StackLogBatch } from "../public/Logs.ts";
import type { EffectStackCredentials } from "../public/Credentials.ts";
import { RuntimeDriverError, type RuntimeDriver } from "../runtime/RuntimeDriver.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { makeSessionLauncher, type SessionLauncher } from "./SessionLauncher.ts";
import {
  makeLifecycleController,
  type LifecycleBackend,
  type LifecycleInput,
} from "./Lifecycle.ts";
import { EMPTY_LOG_CURSOR, selectLogBatch, type LogStore } from "./LogStore.ts";
import type { SupervisorIngress } from "./Ingress.ts";
import { StackRpcGroup, type StackRpcError, type StackRpcHandlers } from "../control/StackRpc.ts";
import type { MaintenanceResponse } from "../control/MaintenanceProtocol.ts";
import { statusFor, type ActualPhase } from "./StatusProjection.ts";
import {
  AUTH_ANON_KEY_SLOT,
  AUTH_PUBLISHABLE_KEY_SLOT,
  AUTH_SECRET_KEY_SLOT,
  AUTH_SERVICE_ROLE_KEY_SLOT,
} from "../state/SecretStore.ts";

import type { ActivationResult } from "../gateway/Gateway.ts";

interface SupervisorLaunchAttempt {
  /** Rolls back only workloads and ingress acquired by this launch. */
  readonly rollback: Effect.Effect<void, StackError>;
}

/** Runtime construction is injected so catalog/artifact resolution can evolve independently. */
export interface SupervisorRuntime {
  readonly driver: RuntimeDriver;
  readonly preflight: (input: LifecycleInput) => Effect.Effect<void, StackError>;
  readonly activate: (
    capability: CapabilityName,
    input: LifecycleInput,
  ) => Effect.Effect<ActivationResult["endpoint"], GatewayActivationError | StackError>;
  /** Supervisor-owned public ingress and lazy route activation lifecycle. */
  readonly ingress: SupervisorIngress;
  readonly logStore: LogStore;
}

export interface Supervisor {
  readonly status: Effect.Effect<StackStatus, StackError>;
  readonly start: (options?: {
    readonly config?: StackConfig;
  }) => Effect.Effect<StackStatus, StackError>;
  readonly destroy: Effect.Effect<void, StackError>;
  /** Completes after a successful stop or destroy shutdown signal. */
  readonly shutdown: Effect.Effect<void>;
  /** Shuts down only when durable state is absent or cleanly non-running. */
  readonly shutdownIfIdle: Effect.Effect<void>;
  readonly logs: (query?: LogQuery) => Effect.Effect<StackLogBatch, StackError>;
  readonly activate: (
    capability: CapabilityName,
  ) => Effect.Effect<ActivationResult, GatewayActivationError | StackError>;
  readonly maintenanceHandlers: {
    readonly probe: Effect.Effect<MaintenanceResponse>;
    readonly stop: Effect.Effect<MaintenanceResponse>;
  };
  readonly rpcHandlers: StackRpcHandlers;
}

export type SupervisorOptions = {
  readonly stackId: StackId;
  readonly ownerSessionId: string;
  readonly rpcRelease: string;
  readonly stateStore: StackStateStore;
  readonly context: Context.Context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>;
  readonly runtime: SupervisorRuntime;
};

const rpcError = (tag: StackRpcError["tag"], message: string): StackRpcError => ({ tag, message });
const stateErrorMessage = (error: StackError | { readonly message?: string }): string =>
  typeof error.message === "string" ? error.message : "Stack operation failed";

const credentialHost = (address: string): string =>
  address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;

const mapRuntimeError = (error: unknown): StackError => {
  if (error instanceof StackStateInvalidError) return error;
  if (error instanceof ContainerEngineError) return error;
  if (error instanceof RuntimeDriverError && isStackError(error.cause)) return error.cause;
  return new StackRuntimeError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
};

const mapCleanupError = (error: unknown): StackError => {
  if (error instanceof StackStateInvalidError) return error;
  return new StackCleanupError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
};

const rpcTag = (error: StackError): StackRpcError["tag"] => error._tag;
const maintenanceStackErrorTag = (error: unknown): StackErrorTag | undefined =>
  Predicate.hasProperty(error, "_tag") &&
  typeof error._tag === "string" &&
  isStackErrorTag(error._tag)
    ? error._tag
    : undefined;

/** Compose one owner process around the durable lifecycle controller and a runtime driver. */
export const makeSupervisor = (
  options: SupervisorOptions,
): Effect.Effect<Supervisor, StackError, Scope.Scope> =>
  Effect.gen(function* () {
    const read = () =>
      options.stateStore.read(options.stackId).pipe(Effect.provideContext(options.context));
    const initial = yield* read();
    if (initial === undefined)
      return yield* new StackStateInvalidError({ message: "Stack state is missing" });
    const runtime = options.runtime;
    const launcher: SessionLauncher = yield* makeSessionLauncher({
      stackId: options.stackId,
      driver: runtime.driver,
    });
    const active = yield* Ref.make<ReadonlySet<CapabilityName>>(new Set());
    const phase = yield* Ref.make<ActualPhase>("stopped");
    // A failed cleanup leaves the owner in `stopping` so callers can retry an exact cleanup.
    // This marker is set by the backend cleanup boundary and read only by start failure handling.
    const cleanupProven = yield* Ref.make(true);
    // A Supervisor created after a crash must clean exact runtime ephemera once before its first
    // fresh start. The marker is session-local and only advances after cleanup succeeds.
    const sessionInitialized = yield* Ref.make(false);
    type ActivationHandler = (
      capability: CapabilityName,
    ) => Effect.Effect<ActivationResult, GatewayActivationError | StackError>;
    // The ingress opens during an explicit lifecycle operation. A one-shot handoff keeps a request
    // waiting for the handler instead of exposing a construction-time race.
    const activationHandler = yield* Deferred.make<ActivationHandler, never>();
    const ingressActivate = (
      capability: CapabilityName,
    ): Effect.Effect<ActivationResult, GatewayActivationError | StackError> =>
      Deferred.await(activationHandler).pipe(Effect.flatMap((handler) => handler(capability)));
    const initializeActivation = (plan: ExecutionPlan) => Ref.set(active, eagerCapabilities(plan));
    const resetForSession = (input: LifecycleInput) =>
      Effect.gen(function* () {
        activationOwned.clear();
        yield* launcher.clear;
        yield* initializeActivation(input.plan);
      });
    const observe = () =>
      runtime.driver.observe(options.stackId).pipe(Effect.mapError(mapRuntimeError));
    const observedForStatus = () =>
      Ref.get(phase).pipe(
        Effect.flatMap((current) => (current === "running" ? observe() : Effect.succeed([]))),
      );

    const snapshot = (): Effect.Effect<StackStatus, StackError> =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        const status = yield* statusFor(
          state,
          yield* observedForStatus(),
          yield* Ref.get(active),
          yield* Ref.get(phase),
        );
        return status;
      });
    const restorePhase = (previous: ActualPhase): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const state = yield* read().pipe(Effect.orElseSucceed(() => undefined));
        const currentPhase = yield* Ref.get(phase);
        let next: ActualPhase = "stopped";
        if (state?.desiredLifecycle === "destroying") next = "destroying";
        else if (state?.desiredLifecycle === "running") {
          if (currentPhase === "running" || previous === "running") next = "running";
          else next = "stopping";
        }
        yield* Ref.set(phase, next);
      });

    // Admission rejects every overlapping lifecycle operation while execution serializes
    // lifecycle and activation work against runtime access.
    const admission = yield* Semaphore.make(1);
    // Activation and lifecycle operations share one execution gate so they cannot race cleanup.
    const execution = yield* Semaphore.make(1);
    const supervisorScope = yield* Effect.scope;
    const ownedFibers = yield* FiberSet.make().pipe(
      Effect.provideService(Scope.Scope, supervisorScope),
    );
    const joinExit = <A, E>(result: Exit.Exit<A, E>): Effect.Effect<A, E> =>
      Exit.isSuccess(result) ? Effect.succeed(result.value) : Effect.failCause(result.cause);
    type LifecycleKind = "start" | "stop" | "destroy";
    type LifecycleResult = Deferred.Deferred<Exit.Exit<void, StackError>, never>;
    type ActiveLifecycle = Readonly<{
      kind: LifecycleKind;
      result: LifecycleResult;
    }>;
    const lifecycleActive = yield* Ref.make<ActiveLifecycle | undefined>(undefined);
    const ensureActivationAllowed = (): Effect.Effect<
      PersistedStackState,
      GatewayActivationError | StackError
    > =>
      Effect.gen(function* () {
        const lifecycle = yield* Ref.get(lifecycleActive);
        if (lifecycle !== undefined)
          return yield* new StackLifecycleConflictError({
            stackId: options.stackId,
            message: `Cannot activate while ${lifecycle.kind} is in progress`,
          });
        if ((yield* Ref.get(phase)) === "stopping")
          return yield* new StackLifecycleConflictError({
            stackId: options.stackId,
            message: "Cannot activate while exact cleanup is pending; stop the stack first",
          });
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        if (state.desiredLifecycle !== "running")
          return yield* new StackNotRunningError({
            message: "Stack must be running before activation",
          });
        return state;
      });
    const shutdownSignal = yield* Deferred.make<void, never>();
    const signalShutdown = Deferred.succeed(shutdownSignal, undefined).pipe(Effect.asVoid);
    const ensureAcceptingOperations = Deferred.poll(shutdownSignal).pipe(
      Effect.flatMap((shutdown) =>
        Option.isNone(shutdown)
          ? Effect.void
          : Effect.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                message: "Stack owner is shutting down",
              }),
            ),
      ),
    );

    const submitLifecycle = (
      kind: LifecycleKind,
      effect: Effect.Effect<void, StackError>,
    ): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        const result = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const owned = yield* admission.withPermit(
              Effect.gen(function* () {
                yield* ensureAcceptingOperations;
                const current = yield* Ref.get(lifecycleActive);
                if (current !== undefined) {
                  return yield* new StackLifecycleConflictError({
                    stackId: options.stackId,
                    message: `Lifecycle operation ${current.kind} is already active`,
                  });
                }
                const deferred = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
                yield* Ref.set(lifecycleActive, { kind, result: deferred });
                const release = admission.withPermit(
                  Ref.update(lifecycleActive, (current) =>
                    current?.result === deferred ? undefined : current,
                  ),
                );
                const owner = Effect.gen(function* () {
                  const result = yield* execution.withPermit(effect).pipe(Effect.exit);
                  // Release the admission slot before waking waiters so a completed operation
                  // cannot make the next lifecycle request look like a conflict.
                  yield* release;
                  yield* Deferred.succeed(deferred, result);
                }).pipe(Effect.ensuring(release));
                yield* FiberSet.run(ownedFibers, owner, { startImmediately: true });
                return deferred;
              }),
            );
            return yield* restore(Deferred.await(owned));
          }),
        );
        return yield* joinExit(result);
      });

    const launchBackend = (
      input: LifecycleInput,
      session: "fresh" | "current",
      selectedOverride?: ReadonlySet<CapabilityName>,
    ): Effect.Effect<SupervisorLaunchAttempt, StackError> =>
      Effect.gen(function* () {
        if (session === "fresh") yield* resetForSession(input);
        const selected = selectedOverride ?? (yield* Ref.get(active));
        const plan = activeExecutionPlan(input.plan, selected);
        const reservation = yield* runtime.ingress.acquire(input);
        const launched = yield* launcher
          .launch(plan)
          .pipe(Effect.mapError(mapRuntimeError), Effect.exit);
        if (Exit.isFailure(launched)) {
          const closed = reservation.fresh
            ? yield* runtime.ingress.close.pipe(Effect.mapError(mapRuntimeError), Effect.exit)
            : Exit.succeed(undefined);
          const launchCleanupProven = yield* launcher.cleanupProven;
          let cause: Cause.Cause<StackError> = launched.cause;
          if (Exit.isFailure(closed)) cause = Cause.combine(cause, closed.cause);
          if (session === "current" && (!launchCleanupProven || Exit.isFailure(closed))) {
            yield* Ref.set(phase, "stopping");
            if (!reservation.fresh && !Exit.isFailure(closed)) {
              const fenced = yield* runtime.ingress.close.pipe(
                Effect.mapError(mapRuntimeError),
                Effect.exit,
              );
              if (Exit.isFailure(fenced)) cause = Cause.combine(cause, fenced.cause);
            }
          }
          return yield* Effect.failCause(cause);
        }
        const rollback: Effect.Effect<void, StackError> = Effect.gen(function* () {
          const workload = yield* launched.value.rollback.pipe(
            Effect.mapError(mapRuntimeError),
            Effect.exit,
          );
          const closed = reservation.fresh
            ? yield* runtime.ingress.close.pipe(Effect.mapError(mapRuntimeError), Effect.exit)
            : Exit.succeed(undefined);
          let cause: Cause.Cause<StackError> = Cause.empty;
          if (Exit.isFailure(workload)) cause = Cause.combine(cause, workload.cause);
          if (Exit.isFailure(closed)) cause = Cause.combine(cause, closed.cause);
          if (cause.reasons.length > 0) return yield* Effect.failCause(cause);
        });
        const opened = yield* runtime.ingress
          .open(input, reservation, ingressActivate)
          .pipe(Effect.exit);
        if (Exit.isFailure(opened)) {
          const rolledBack = yield* rollback.pipe(Effect.exit);
          let cause: Cause.Cause<StackError> = opened.cause;
          if (Exit.isFailure(rolledBack)) cause = Cause.combine(cause, rolledBack.cause);
          if (Exit.isFailure(rolledBack)) {
            yield* Ref.set(cleanupProven, false);
            if (session === "current") {
              yield* Ref.set(phase, "stopping");
            }
          }
          return yield* Effect.failCause(cause);
        }
        if (session === "fresh") yield* Ref.set(sessionInitialized, true);
        return { rollback } satisfies SupervisorLaunchAttempt;
      });

    const cleanupRuntime = (destroy: boolean): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        yield* Ref.set(cleanupProven, true);
        const ingress = yield* runtime.ingress.close.pipe(
          Effect.mapError(mapCleanupError),
          Effect.exit,
        );
        const launched = destroy
          ? Exit.succeed(undefined)
          : yield* launcher.stop.pipe(Effect.mapError(mapCleanupError), Effect.exit);
        const driver = yield* runtime.driver
          .cleanup({ stackId: options.stackId, destroy })
          .pipe(Effect.mapError(mapCleanupError), Effect.exit);
        let cause: Cause.Cause<StackError> = Cause.empty;
        for (const result of [ingress, launched, driver])
          if (Exit.isFailure(result)) cause = Cause.combine(cause, result.cause);
        if (cause.reasons.length > 0) {
          yield* Ref.set(cleanupProven, false);
          return yield* Effect.failCause(cause);
        }
        if (!destroy) {
          yield* Ref.set(active, new Set());
        } else {
          yield* launcher.clear;
        }
      });
    const backend: LifecycleBackend = {
      preflight: runtime.preflight,
      launch: launchBackend,
      cleanup: cleanupRuntime(false),
      destroyData: cleanupRuntime(true),
    };
    const controller = yield* makeLifecycleController({
      stackId: options.stackId,
      runtime: initial.runtime,
      stateStore: options.stateStore,
      backend,
    }).pipe(Effect.provideContext(options.context));
    const status = snapshot();

    const activateOperation = (
      capability: CapabilityName,
    ): Effect.Effect<ActivationResult, GatewayActivationError | StackError> =>
      Effect.gen(function* () {
        const state = yield* ensureActivationAllowed();
        const definition = state.definition;
        if (definition === undefined || !definition.capabilities[capability].enabled)
          return yield* new GatewayActivationError({
            message: `Capability ${capability} is not enabled`,
          });
        const plan = yield* rebuildExecutionPlan(state.runtime, definition).pipe(
          Effect.provideContext(options.context),
          Effect.mapError(
            (error) => new StackStateInvalidError({ message: error.message, cause: error }),
          ),
        );
        const previousActive = yield* Ref.get(active);
        const next = new Set([...previousActive, ...dependencyClosure(plan, [capability])]);
        const input: LifecycleInput = {
          stackId: options.stackId,
          state,
          definition,
          secrets: state.secrets,
          plan,
        };
        // Activation is accepted for this lifecycle session before launching its dependency closure.
        // A failed attempt removes only newly-created resources; the capability remains retryable.
        const launched = yield* launchBackend(input, "current", next);
        yield* Ref.set(active, next);
        yield* Ref.set(phase, "running");
        const activated = yield* runtime.activate(capability, input).pipe(Effect.exit);
        if (Exit.isFailure(activated)) {
          yield* Ref.set(active, previousActive);
          const rolledBack = yield* launched.rollback.pipe(Effect.exit);
          if (Exit.isFailure(rolledBack)) {
            yield* Ref.set(phase, "stopping");
            const cause: Cause.Cause<StackError> = Cause.combine(activated.cause, rolledBack.cause);
            return yield* Effect.failCause(cause);
          }
          return yield* Effect.failCause(activated.cause);
        }
        const endpoint = activated.value;
        return { capability, endpoint };
      });

    const activationOwned = new Map<
      CapabilityName,
      | {
          readonly _tag: "pending";
          readonly result: Deferred.Deferred<
            Exit.Exit<ActivationResult, GatewayActivationError | StackError>,
            never
          >;
        }
      | { readonly _tag: "ready"; readonly result: ActivationResult }
    >();
    type ActivationExit = Exit.Exit<ActivationResult, GatewayActivationError | StackError>;
    type ActivationToken =
      | { readonly _tag: "exit"; readonly result: ActivationExit }
      | {
          readonly _tag: "deferred";
          readonly result: Deferred.Deferred<ActivationExit, never>;
        };
    const activate = (
      capability: CapabilityName,
    ): Effect.Effect<ActivationResult, GatewayActivationError | StackError> =>
      Effect.gen(function* () {
        const token = yield* admission.withPermit(
          Effect.gen(function* () {
            yield* ensureActivationAllowed();
            const current = activationOwned.get(capability);
            if (current?._tag === "ready")
              return {
                _tag: "exit",
                result: Exit.succeed(current.result),
              } satisfies ActivationToken;
            if (current?._tag === "pending")
              return { _tag: "deferred", result: current.result } satisfies ActivationToken;
            const deferred = yield* Deferred.make<
              Exit.Exit<ActivationResult, GatewayActivationError | StackError>,
              never
            >();
            activationOwned.set(capability, { _tag: "pending", result: deferred });
            const owner = Effect.gen(function* () {
              const result = yield* execution
                .withPermit(
                  admission
                    .withPermit(
                      Effect.sync(() => {
                        const current = activationOwned.get(capability);
                        return current?._tag === "pending" && current.result === deferred;
                      }),
                    )
                    .pipe(
                      Effect.flatMap((stillAdmitted) =>
                        stillAdmitted
                          ? activateOperation(capability)
                          : Effect.fail(
                              new StackLifecycleConflictError({
                                stackId: options.stackId,
                                message: "Lazy activation was superseded by a lifecycle transition",
                              }),
                            ),
                      ),
                    ),
                )
                .pipe(Effect.exit);
              yield* admission.withPermit(
                Effect.sync(() => {
                  const current = activationOwned.get(capability);
                  if (current?._tag !== "pending" || current.result !== deferred) return;
                  if (Exit.isSuccess(result))
                    activationOwned.set(capability, { _tag: "ready", result: result.value });
                  else activationOwned.delete(capability);
                }),
              );
              yield* Deferred.succeed(deferred, result);
            }).pipe(
              Effect.ensuring(
                admission.withPermit(
                  Effect.sync(() => {
                    const current = activationOwned.get(capability);
                    if (current?._tag === "pending" && current.result === deferred)
                      activationOwned.delete(capability);
                  }),
                ),
              ),
            );
            yield* FiberSet.run(ownedFibers, owner, { startImmediately: true });
            return { _tag: "deferred", result: deferred } satisfies ActivationToken;
          }),
        );
        if (token._tag === "deferred")
          return yield* Deferred.await(token.result).pipe(Effect.flatMap(joinExit));
        return yield* joinExit(token.result);
      });
    yield* Deferred.succeed(activationHandler, activate);

    const startOperation = (startOptions?: { readonly config?: StackConfig }) =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(phase);
        if (previous === "stopping")
          return yield* new StackLifecycleConflictError({
            stackId: options.stackId,
            message: "Cannot start while exact cleanup is pending; stop the stack first",
          });
        const freshSession = !(yield* Ref.get(sessionInitialized));
        if (freshSession) {
          const cleaned = yield* backend.cleanup.pipe(Effect.exit);
          if (Exit.isFailure(cleaned)) {
            yield* Ref.set(phase, "stopping");
            return yield* Effect.failCause(cleaned.cause);
          }
        }
        if (freshSession || previous === "stopped") yield* Ref.set(phase, "starting");
        const started = yield* controller
          .start({
            config: startOptions?.config,
            freshSession,
          })
          .pipe(Effect.provideContext(options.context), Effect.exit);
        if (Exit.isFailure(started)) {
          if (freshSession || previous === "stopped") {
            const durable = yield* read().pipe(Effect.exit);
            const canReportStopped =
              (yield* Ref.get(cleanupProven)) &&
              Exit.isSuccess(durable) &&
              (durable.value === undefined ||
                durable.value.desiredLifecycle === "stopped" ||
                durable.value.desiredLifecycle === "unconfigured");
            yield* Ref.set(phase, canReportStopped ? "stopped" : "stopping");
          } else yield* restorePhase(previous);
          return yield* Effect.failCause(started.cause);
        }
        yield* Ref.set(phase, "running");
      });
    const start = (startOptions?: { readonly config?: StackConfig }) =>
      Effect.gen(function* () {
        yield* submitLifecycle("start", startOperation(startOptions));
        return yield* snapshot();
      });
    const stopOperation = () =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(phase);
        yield* Ref.set(phase, "stopping");
        const result = yield* controller
          .stop()
          .pipe(Effect.provideContext(options.context), Effect.exit);
        if (Exit.isFailure(result)) {
          const state = yield* read().pipe(Effect.orElseSucceed(() => undefined));
          if (state?.desiredLifecycle === "stopped") {
            // The durable stopped fence is already committed, but cleanup did not complete.
            // Keep the observable phase stopping so callers cannot mistake this for a clean stop.
            yield* Ref.set(phase, "stopping");
          } else {
            yield* restorePhase(previous);
          }
          return yield* Effect.failCause(result.cause);
        }
        yield* Ref.set(phase, "stopped");
      });
    const signalShutdownIfIdle = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const lifecycle = yield* Ref.get(lifecycleActive);
        if (lifecycle !== undefined) {
          yield* Deferred.await(lifecycle.result);
          return yield* signalShutdownIfIdle();
        }
        yield* admission.withPermit(
          Effect.gen(function* () {
            // Recheck ownership after admission: a lifecycle may have started between the
            // initial observation and this critical section. Keep the permit while making the
            // final state/phase decision and signalling shutdown so no new start can slip in.
            if ((yield* Ref.get(lifecycleActive)) !== undefined) return;
            const state = yield* read().pipe(Effect.exit);
            if (Exit.isFailure(state)) return;
            const currentPhase = yield* Ref.get(phase);
            if (
              currentPhase !== "stopping" &&
              (state.value === undefined ||
                state.value.desiredLifecycle === "stopped" ||
                state.value.desiredLifecycle === "unconfigured")
            )
              yield* signalShutdown;
          }),
        );
      });
    const shutdownIfIdle = signalShutdownIfIdle();
    const stopWithShutdown = submitLifecycle("stop", stopOperation());
    const operation = <A>(effect: Effect.Effect<A, StackError>) =>
      effect.pipe(Effect.mapError((error) => rpcError(rpcTag(error), stateErrorMessage(error))));
    const destroyOperation = Effect.gen(function* () {
      const previous = yield* Ref.get(phase);
      yield* Ref.set(phase, "destroying");
      const result = yield* controller
        .destroy()
        .pipe(Effect.provideContext(options.context), Effect.exit);
      if (Exit.isFailure(result)) {
        yield* restorePhase(previous);
        return yield* Effect.failCause(result.cause);
      }
      yield* Ref.set(phase, "stopped");
      return result.value;
    });
    const destroy = submitLifecycle("destroy", destroyOperation).pipe(Effect.asVoid);
    const logs = (query?: LogQuery): Effect.Effect<StackLogBatch, StackError> =>
      Effect.gen(function* () {
        // Capture lifecycle phase before reading the log store. A stopping snapshot stays live
        // and gives followers one more poll rather than racing a final batch.
        const phaseAtRead = yield* Ref.get(phase);
        const cursor =
          query?.cursor?.opaque === EMPTY_LOG_CURSOR.opaque ? undefined : query?.cursor;
        const scanned = yield* runtime.logStore
          .read(cursor === undefined ? undefined : { cursor })
          .pipe(
            Effect.mapError((error) =>
              error instanceof InvalidLogCursorError
                ? error
                : new StackStateInvalidError({ message: error.message, cause: error }),
            ),
          );
        const selected = selectLogBatch(scanned, query);
        const running = phaseAtRead !== "stopped";
        return {
          ...selected,
          running,
        } satisfies StackLogBatch;
      });
    const maintenanceHandlers = {
      probe: Effect.succeed({
        ok: true,
        op: "probe",
        ownerSessionId: options.ownerSessionId,
        stackId: options.stackId,
        rpcRelease: options.rpcRelease,
      } satisfies MaintenanceResponse),
      stop: stopWithShutdown.pipe(
        Effect.provideContext(options.context),
        Effect.as({ ok: true, op: "stop" } satisfies MaintenanceResponse),
        Effect.catch((error) => {
          const stackErrorTag = maintenanceStackErrorTag(error);
          return Effect.succeed({
            ok: false,
            error: {
              tag: "operation-failed",
              message: stateErrorMessage(error),
              ...(stackErrorTag === undefined ? {} : { stackErrorTag }),
            },
          } satisfies MaintenanceResponse);
        }),
      ),
    };
    const credentials: Effect.Effect<EffectStackCredentials, StackRpcError> = Effect.gen(
      function* () {
        const state = yield* read().pipe(
          Effect.mapError((error) => rpcError(rpcTag(error), stateErrorMessage(error))),
        );
        const actualPhase = yield* Ref.get(phase);
        if (
          state === undefined ||
          actualPhase !== "running" ||
          state.desiredLifecycle !== "running"
        )
          return yield* Effect.fail(
            rpcError("StackNotRunningError", "Stack credentials are unavailable"),
          );

        const definition = state.definition;
        const databaseListener = definition?.listeners.database;
        const databaseAssignment = state.ports.find(({ field }) => field === "database");
        if (
          definition === undefined ||
          databaseListener === undefined ||
          !databaseListener.enabled ||
          databaseAssignment === undefined
        )
          return yield* Effect.fail(
            rpcError("StackNotRunningError", "Stack credentials are unavailable"),
          );

        const auth = definition.capabilities.auth;
        if (!auth.enabled)
          return yield* Effect.fail(
            rpcError("StackNotRunningError", "Stack credentials are unavailable"),
          );

        const requiredSecret = (slot: string): Effect.Effect<string, StackRpcError> => {
          const value = state.secrets[slot]?.value;
          return value === undefined || value.length === 0
            ? Effect.fail(
                rpcError("StackSecretMismatchError", "Required stack credential is unavailable"),
              )
            : Effect.succeed(value);
        };

        const databasePassword = yield* requiredSecret("secret:database.internal.password");
        const databaseHost = credentialHost(databaseListener.address);
        const databaseUrl = `postgresql://${encodeURIComponent("postgres")}:${encodeURIComponent(
          databasePassword,
        )}@${databaseHost}:${databaseAssignment.port}/postgres`;

        const publishableKey = yield* requiredSecret(AUTH_PUBLISHABLE_KEY_SLOT);
        const secretKey = yield* requiredSecret(AUTH_SECRET_KEY_SLOT);
        const anonJwt = yield* requiredSecret(AUTH_ANON_KEY_SLOT);
        const serviceRoleJwt = yield* requiredSecret(AUTH_SERVICE_ROLE_KEY_SLOT);

        const base: EffectStackCredentials = {
          database: {
            url: Redacted.make(databaseUrl),
            password: Redacted.make(databasePassword),
          },
          api: {
            publishableKey,
            secretKey: Redacted.make(secretKey),
            anonJwt,
            serviceRoleJwt: Redacted.make(serviceRoleJwt),
          },
        };
        const storage = definition.capabilities.storage;
        const s3 = storage.settings.s3_protocol;
        if (!storage.enabled || s3 === null || s3 === undefined || s3.enabled !== true) return base;

        const apiListener = definition.listeners.api;
        const apiAssignment = state.ports.find(({ field }) => field === "api");
        if (apiListener === undefined || !apiListener.enabled || apiAssignment === undefined)
          return yield* Effect.fail(
            rpcError("StackNotRunningError", "Stack credentials are unavailable"),
          );
        const accessKeyId = s3.access_key_id;
        const region = s3.region;
        if (
          accessKeyId === null ||
          accessKeyId === undefined ||
          accessKeyId.length === 0 ||
          region === null ||
          region === undefined ||
          region.length === 0
        )
          return yield* Effect.fail(
            rpcError("StackStateInvalidError", "Storage credentials are unavailable"),
          );
        const secretAccessKey = yield* requiredSecret(
          "secret:storage.settings.s3_protocol.secret_access_key",
        );
        return {
          ...base,
          storage: {
            endpoint: `http://${credentialHost(apiListener.address)}:${apiAssignment.port}/storage/v1/s3`,
            region,
            accessKeyId,
            secretAccessKey: Redacted.make(secretAccessKey),
          },
        } satisfies EffectStackCredentials;
      },
    );
    const rpcHandlers: StackRpcHandlers = StackRpcGroup.of({
      status: () => operation(status),
      credentials: () => credentials,
      start: ({ config }: { readonly config?: StackConfig }) => operation(start({ config })),
      destroy: () => operation(destroy),
      logs: (query: LogQuery) => operation(logs(query)),
    });
    return {
      status,
      start,
      destroy,
      shutdown: Deferred.await(shutdownSignal),
      shutdownIfIdle,
      logs,
      activate,
      maintenanceHandlers,
      rpcHandlers,
    } satisfies Supervisor;
  });
