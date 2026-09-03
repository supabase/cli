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
  Redacted,
  Ref,
  Semaphore,
  Scope,
} from "effect";
import type { StackIdentity } from "../identity/Identity.ts";
import { rebuildExecutionPlan } from "../model/Compiler.ts";
import {
  activeExecutionPlan,
  eagerCapabilities,
  type ExecutionPlan,
  type PlannedWorkload,
} from "../model/ExecutionPlan.ts";
import type { CapabilityName } from "../public/Capability.ts";
import type { StackConfig } from "../public/Config.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import {
  GatewayActivationError,
  StackLifecycleConflictError,
  StackNotRunningError,
  StackReconciliationError,
  StackStateInvalidError,
  type StackError,
} from "../public/Errors.ts";
import type { StackStatus } from "../public/Status.ts";
import type { StackId } from "../public/StackId.ts";
import type { LogQuery, StackLogBatch } from "../public/Logs.ts";
import type { EffectStackCredentials } from "../public/Credentials.ts";
import type { RuntimeDriver } from "../runtime/RuntimeDriver.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import {
  makeSessionLauncher,
  type SessionLaunch,
  type SessionLauncher,
} from "./SessionLauncher.ts";
import {
  makeLifecycleController,
  type LifecycleBackend,
  type LifecycleInput,
} from "./Lifecycle.ts";
import type { LogStore } from "./LogStore.ts";
import type { SupervisorIngress } from "./Ingress.ts";
import { StackRpcGroup, type StackRpcError, type StackRpcHandlers } from "../control/StackRpc.ts";
import type { MaintenanceResponse } from "../control/MaintenanceProtocol.ts";
import type { PreparedWorkloadArtifact } from "../preparation/RuntimeArtifacts.ts";
import { statusFor, type ActualPhase } from "./StatusProjection.ts";

interface ActivationResult {
  readonly capability: CapabilityName;
  readonly endpoint: { readonly host: string; readonly port: number };
}

/** Runtime construction is injected so catalog/artifact resolution can evolve independently. */
export interface SupervisorRuntime {
  readonly driver: RuntimeDriver;
  /** Verifies and prepares immutable workload artifacts without changing lifecycle state. */
  readonly prepare: (
    runtime: StackRuntime,
    workloads: ReadonlyArray<PlannedWorkload>,
  ) => Effect.Effect<ReadonlyArray<PreparedWorkloadArtifact>, StackError>;
  readonly preflight: (
    input: LifecycleInput,
    mode: "cold" | "live",
  ) => Effect.Effect<void, StackError>;
  readonly activate: (
    capability: CapabilityName,
    input: LifecycleInput,
  ) => Effect.Effect<ActivationResult["endpoint"], GatewayActivationError | StackError>;
  /** Supervisor-owned public ingress and lazy route activation lifecycle. */
  readonly ingress: SupervisorIngress;
  readonly logStore: LogStore;
}

export interface SupervisorRuntimeFactory {
  readonly make: (state: PersistedStackState) => Effect.Effect<SupervisorRuntime, StackError>;
}

export interface Supervisor {
  readonly identity: StackIdentity;
  readonly stackId: StackId;
  readonly ownerSessionId: string;
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

type SupervisorRuntimeInput =
  | {
      readonly runtime: SupervisorRuntime;
      readonly runtimeFactory?: never;
    }
  | {
      readonly runtimeFactory: SupervisorRuntimeFactory;
      readonly runtime?: never;
    };

export type SupervisorOptions = {
  readonly identity: StackIdentity;
  readonly stackId: StackId;
  readonly ownerSessionId: string;
  readonly rpcRelease: string;
  readonly stateStore: StackStateStore;
  readonly context: Context.Context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>;
} & SupervisorRuntimeInput;

const rpcError = (tag: StackRpcError["tag"], message: string): StackRpcError => ({ tag, message });
const stateErrorMessage = (error: StackError | { readonly message?: string }): string =>
  typeof error.message === "string" ? error.message : "Stack operation failed";

const credentialHost = (address: string): string =>
  address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;

const mapReconcileError = (error: unknown): StackError => {
  if (error instanceof StackStateInvalidError) return error;
  return new StackReconciliationError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
};

const rpcTag = (error: StackError): StackRpcError["tag"] => error._tag;

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
    const runtime =
      options.runtimeFactory !== undefined
        ? yield* options.runtimeFactory.make(initial)
        : options.runtime;
    const launcher: SessionLauncher = yield* makeSessionLauncher({
      stackId: options.stackId,
      driver: runtime.driver,
    });
    const active = yield* Ref.make<ReadonlySet<CapabilityName>>(new Set());
    const phase = yield* Ref.make<ActualPhase>("stopped");
    // A failed cleanup leaves the owner in `stopping` so callers can retry an exact cleanup.
    // This marker is set by the backend cleanup boundary and read only by start failure handling.
    const cleanupProven = yield* Ref.make(true);
    // A lazy activation rollback that cannot be proven leaves the owner fenced in stopping until
    // an explicit stop retries exact cleanup.
    const activationRollbackUnproven = yield* Ref.make(false);
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
        yield* Ref.set(activationRollbackUnproven, false);
        yield* launcher.clear;
        yield* initializeActivation(input.plan);
      });
    const observe = () =>
      runtime.driver.observe(options.stackId).pipe(Effect.mapError(mapReconcileError));
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
    const publish = (): Effect.Effect<StackStatus, StackError> => snapshot();
    const restorePhase = (previous: ActualPhase): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const state = yield* read().pipe(Effect.orElseSucceed(() => undefined));
        const currentPhase = yield* Ref.get(phase);
        let next: ActualPhase = "stopped";
        if (state?.desiredLifecycle === "destroying") next = "destroying";
        else if (state?.desiredLifecycle === "running") {
          if (currentPhase === "running" || previous === "running") next = "running";
          else next = "starting";
        }
        yield* Ref.set(phase, next);
        yield* publish().pipe(Effect.ignore);
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
      onWaiterInterrupt?: (owned: LifecycleResult) => Effect.Effect<void>,
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
                  yield* shutdownIfIdle;
                }).pipe(Effect.ensuring(release));
                yield* FiberSet.run(ownedFibers, owner, { startImmediately: true });
                return deferred;
              }),
            );
            const awaitResult =
              onWaiterInterrupt === undefined
                ? Deferred.await(owned)
                : Deferred.await(owned).pipe(Effect.onInterrupt(() => onWaiterInterrupt(owned)));
            return yield* restore(awaitResult);
          }),
        );
        return yield* joinExit(result);
      });

    const launchBackend = (
      input: LifecycleInput,
      session: "fresh" | "current",
      selectedOverride?: ReadonlySet<CapabilityName>,
    ): Effect.Effect<SessionLaunch | undefined, StackError> =>
      Effect.gen(function* () {
        if (session === "fresh") yield* resetForSession(input);
        if (input.desiredLifecycle !== "running") return undefined;
        const selected = selectedOverride ?? (yield* Ref.get(active));
        const plan = activeExecutionPlan(input.plan, selected);
        const reservation = yield* runtime.ingress.acquire(input);
        const launched = yield* launcher
          .launch(plan)
          .pipe(Effect.mapError(mapReconcileError), Effect.exit);
        if (Exit.isFailure(launched)) {
          if (reservation.fresh) yield* runtime.ingress.close.pipe(Effect.ignore);
          if (session === "current" && !(yield* launcher.cleanupProven)) {
            yield* Ref.set(activationRollbackUnproven, true);
            yield* Ref.set(phase, "stopping");
            const closed = yield* runtime.ingress.close.pipe(
              Effect.mapError(mapReconcileError),
              Effect.exit,
            );
            if (Exit.isFailure(closed))
              return yield* Effect.failCause(Cause.combine(launched.cause, closed.cause));
            yield* publish().pipe(Effect.ignore);
          }
          return yield* Effect.failCause(launched.cause);
        }
        const opened = yield* runtime.ingress
          .open(input, reservation, ingressActivate)
          .pipe(Effect.exit);
        if (Exit.isFailure(opened)) {
          const rolledBack = yield* launched.value.rollback.pipe(
            Effect.mapError(mapReconcileError),
            Effect.exit,
          );
          const closed = reservation.fresh
            ? yield* runtime.ingress.close.pipe(Effect.mapError(mapReconcileError), Effect.exit)
            : Exit.succeed(undefined);
          let cause: Cause.Cause<StackError> = opened.cause;
          if (Exit.isFailure(rolledBack)) cause = Cause.combine(cause, rolledBack.cause);
          if (Exit.isFailure(closed)) cause = Cause.combine(cause, closed.cause);
          if (Exit.isFailure(rolledBack)) {
            yield* Ref.set(cleanupProven, false);
            if (session === "current") {
              yield* Ref.set(activationRollbackUnproven, true);
              yield* Ref.set(phase, "stopping");
              yield* publish().pipe(Effect.ignore);
            }
          }
          return yield* Effect.failCause(cause);
        }
        if (session === "fresh") yield* Ref.set(sessionInitialized, true);
        yield* publish();
        return launched.value;
      });

    const cleanupRuntime = (destroy: boolean): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        yield* Ref.set(cleanupProven, true);
        const ingress = yield* runtime.ingress.close.pipe(
          Effect.mapError(mapReconcileError),
          Effect.exit,
        );
        const launched = destroy
          ? Exit.succeed(undefined)
          : yield* launcher.stop.pipe(Effect.mapError(mapReconcileError), Effect.exit);
        const driver = yield* runtime.driver
          .cleanup({ stackId: options.stackId, destroy })
          .pipe(Effect.mapError(mapReconcileError), Effect.exit);
        let cause: Cause.Cause<StackError> = Cause.empty;
        for (const result of [ingress, launched, driver])
          if (Exit.isFailure(result)) cause = Cause.combine(cause, result.cause);
        if (cause.reasons.length > 0) {
          yield* Ref.set(cleanupProven, false);
          return yield* Effect.failCause(cause);
        }
        if (!destroy) {
          yield* Ref.set(active, new Set());
          yield* Ref.set(activationRollbackUnproven, false);
          yield* publish();
        } else {
          yield* launcher.clear;
        }
      });
    const backend: LifecycleBackend = {
      preflight: runtime.preflight,
      reconcile: launchBackend,
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
        const lifecycle = yield* Ref.get(lifecycleActive);
        if (lifecycle !== undefined)
          return yield* new StackLifecycleConflictError({
            stackId: options.stackId,
            message: `Cannot activate while ${lifecycle.kind} is in progress`,
          });
        if ((yield* Ref.get(activationRollbackUnproven)) || (yield* Ref.get(phase)) === "stopping")
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
        const next = new Set(previousActive);
        const visit = (name: CapabilityName): void => {
          if (next.has(name)) return;
          next.add(name);
          for (const dependency of plan.dependencies[name]) visit(dependency);
        };
        visit(capability);
        const input: LifecycleInput = {
          stackId: options.stackId,
          desiredLifecycle: "running",
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
        yield* publish().pipe(Effect.ignore);
        const activated = yield* runtime.activate(capability, input).pipe(Effect.exit);
        if (Exit.isFailure(activated)) {
          yield* Ref.set(active, previousActive);
          if (launched !== undefined) {
            const rolledBack = yield* launched.rollback.pipe(
              Effect.mapError(mapReconcileError),
              Effect.exit,
            );
            if (Exit.isFailure(rolledBack)) {
              yield* Ref.set(activationRollbackUnproven, true);
              yield* Ref.set(phase, "stopping");
              const closed = yield* runtime.ingress.close.pipe(
                Effect.mapError(mapReconcileError),
                Effect.exit,
              );
              let cause: Cause.Cause<StackError> = Cause.combine(activated.cause, rolledBack.cause);
              if (Exit.isFailure(closed)) cause = Cause.combine(cause, closed.cause);
              return yield* Effect.failCause(cause);
            }
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
        const lifecycle = yield* Ref.get(lifecycleActive);
        if (lifecycle !== undefined)
          return yield* new StackLifecycleConflictError({
            stackId: options.stackId,
            message: `Cannot activate while ${lifecycle.kind} is in progress`,
          });
        const token = yield* admission.withPermit(
          Effect.gen(function* () {
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
        const freshSession = !(yield* Ref.get(sessionInitialized));
        if (freshSession || previous === "stopping") {
          const cleaned = yield* backend.cleanup.pipe(Effect.exit);
          if (Exit.isFailure(cleaned)) {
            yield* Ref.set(phase, "stopping");
            yield* publish().pipe(Effect.ignore);
            return yield* Effect.failCause(cleaned.cause);
          }
          yield* Ref.set(phase, "starting");
          yield* publish().pipe(Effect.ignore);
        }
        const started = yield* controller
          .start({
            config: startOptions?.config,
            freshSession,
          })
          .pipe(Effect.provideContext(options.context), Effect.exit);
        if (Exit.isFailure(started)) {
          if (freshSession) {
            const durable = yield* read().pipe(Effect.exit);
            const canReportStopped =
              (yield* Ref.get(cleanupProven)) &&
              Exit.isSuccess(durable) &&
              durable.value !== undefined &&
              (durable.value.desiredLifecycle === "stopped" ||
                durable.value.desiredLifecycle === "unconfigured");
            yield* Ref.set(phase, canReportStopped ? "stopped" : "stopping");
            yield* publish().pipe(Effect.ignore);
          } else yield* restorePhase(previous);
          return yield* Effect.failCause(started.cause);
        }
        yield* Ref.set(phase, "running");
        yield* publish();
      });
    const start = (startOptions?: { readonly config?: StackConfig }) =>
      Effect.gen(function* () {
        yield* submitLifecycle("start", startOperation(startOptions), continueShutdown);
        return yield* snapshot();
      });
    const stopOperation = () =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(phase);
        yield* Ref.set(phase, "stopping");
        yield* publish().pipe(Effect.ignore);
        const result = yield* controller
          .stop()
          .pipe(Effect.provideContext(options.context), Effect.exit);
        if (Exit.isFailure(result)) {
          const state = yield* read().pipe(Effect.orElseSucceed(() => undefined));
          if (state?.desiredLifecycle === "stopped") {
            // The durable stopped fence is already committed, but cleanup did not complete.
            // Keep the observable phase stopping so callers cannot mistake this for a clean stop.
            yield* Ref.set(phase, "stopping");
            yield* publish().pipe(Effect.ignore);
          } else {
            yield* restorePhase(previous);
          }
          return yield* Effect.failCause(result.cause);
        }
        yield* Ref.set(phase, "stopped");
        yield* publish();
      });
    const shutdownIfIdle = admission.withPermit(
      Effect.gen(function* () {
        const state = yield* read().pipe(Effect.exit);
        if (Exit.isFailure(state)) return;
        const lifecycle = yield* Ref.get(lifecycleActive);
        const currentPhase = yield* Ref.get(phase);
        if (
          lifecycle === undefined &&
          currentPhase !== "stopping" &&
          (state.value === undefined ||
            state.value.desiredLifecycle === "stopped" ||
            state.value.desiredLifecycle === "unconfigured")
        )
          yield* signalShutdown;
      }),
    );
    const continueShutdown = <A, E>(owned: Deferred.Deferred<Exit.Exit<A, E>, never>) =>
      FiberSet.run(ownedFibers, Deferred.await(owned).pipe(Effect.andThen(shutdownIfIdle)), {
        startImmediately: true,
      }).pipe(Effect.asVoid);
    // An interrupted stop waiter still requests shutdown after the owned operation succeeds.
    const stopWithShutdown = submitLifecycle("stop", stopOperation(), continueShutdown);
    const operation = <A>(effect: Effect.Effect<A, StackError>) =>
      effect.pipe(Effect.mapError((error) => rpcError(rpcTag(error), stateErrorMessage(error))));
    const destroyOperation = Effect.gen(function* () {
      const previous = yield* Ref.get(phase);
      yield* Ref.set(phase, "destroying");
      yield* publish().pipe(Effect.ignore);
      const result = yield* controller
        .destroy()
        .pipe(Effect.provideContext(options.context), Effect.exit);
      if (Exit.isFailure(result)) {
        yield* restorePhase(previous);
        return yield* Effect.failCause(result.cause);
      }
      yield* Ref.set(phase, "stopped");
      yield* publish().pipe(Effect.ignore);
      return result.value;
    });
    const destroy = submitLifecycle("destroy", destroyOperation, continueShutdown).pipe(
      Effect.asVoid,
    );
    const logs = (query?: LogQuery): Effect.Effect<StackLogBatch, StackError> =>
      Effect.gen(function* () {
        // Capture lifecycle phase before reading the log store. Stop publishes the stopped
        // phase only after cleanup has appended terminal records; a stopping snapshot therefore
        // stays live and gives followers one more poll rather than racing a final batch.
        const phaseAtRead = yield* Ref.get(phase);
        const cursor = query?.cursor?.opaque === "v1_0" ? undefined : query?.cursor;
        const scanned = yield* runtime.logStore
          .read(cursor === undefined ? undefined : { cursor })
          .pipe(
            Effect.mapError(
              (error) => new StackStateInvalidError({ message: error.message, cause: error }),
            ),
          );
        const capabilities =
          query?.capabilities === undefined ? undefined : new Set(query.capabilities);
        const filtered = scanned.filter((entry) =>
          capabilities === undefined
            ? true
            : entry.source !== "gateway" &&
              entry.source !== "supervisor" &&
              capabilities.has(entry.source),
        );
        const entries =
          query?.tail === undefined
            ? filtered
            : query.tail <= 0
              ? []
              : filtered.slice(-Math.floor(query.tail));
        const running = phaseAtRead !== "stopped";
        return {
          entries,
          cursor: scanned.at(-1)?.cursor ?? query?.cursor ?? { opaque: "v1_0" },
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
        Effect.catch((error) =>
          Effect.succeed({
            ok: false,
            error: { tag: "operation-failed", message: stateErrorMessage(error) },
          } satisfies MaintenanceResponse),
        ),
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

        const publishableKey = yield* requiredSecret("secret:auth.settings.publishable_key");
        const secretKey = yield* requiredSecret("secret:auth.settings.secret_key");
        const anonJwt = yield* requiredSecret("secret:auth.settings.anon_key");
        const serviceRoleJwt = yield* requiredSecret("secret:auth.settings.service_role_key");

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
      identity: options.identity,
      stackId: options.stackId,
      ownerSessionId: options.ownerSessionId,
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
