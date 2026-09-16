import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  FiberSet,
  Match,
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
import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
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
import type { ArtifactPreparationStatus, StackStatus } from "../public/Status.ts";
import type { StackId } from "../public/StackId.ts";
import type { LogQuery, StackLogBatch } from "../public/Logs.ts";
import type { EffectStackCredentials } from "../public/Credentials.ts";
import {
  RuntimeDriverError,
  type ObservedWorkload,
  type RuntimeDriver,
} from "../runtime/RuntimeDriver.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { isMissingStateRemnantError, type StackStateStore } from "../state/StackStateStore.ts";
import {
  makeSessionLauncher,
  SessionCleanupError,
  type SessionCleanupOutcome,
  type SessionLaunchOutcome,
  type SessionLauncher,
} from "./SessionLauncher.ts";
import {
  makeLifecycleController,
  type CleanupOutcome,
  type LifecycleLaunchResult,
  type LifecycleBackend,
  type LifecycleInput,
} from "./Lifecycle.ts";
import { EMPTY_LOG_CURSOR, selectLogBatch, type LogStore } from "./LogStore.ts";
import type { SupervisorIngress } from "./Ingress.ts";
import {
  STACK_RPC_RELEASE,
  StackRpcGroup,
  type StackRpcError,
  type StackRpcHandlers,
} from "../control/StackRpc.ts";
import type { MaintenanceResponse } from "../control/MaintenanceProtocol.ts";
import { statusForSnapshot, type ActualPhase, type ObservedStatus } from "./StatusProjection.ts";
import {
  recoveryForState,
  type LifecycleKind,
  type SupervisorSnapshot,
} from "./SupervisorState.ts";
import {
  AUTH_ANON_KEY_SLOT,
  AUTH_PUBLISHABLE_KEY_SLOT,
  AUTH_SECRET_KEY_SLOT,
  AUTH_SERVICE_ROLE_KEY_SLOT,
  DATABASE_INTERNAL_PASSWORD_SLOT,
} from "../state/SecretStore.ts";

import type { ActivationResult } from "../gateway/Gateway.ts";
import { makeGatewayActivity } from "../gateway/ActivityTracker.ts";
import {
  admitLifecycle,
  admitActivation,
  activationGate,
  beginTraffic as transitionBeginTraffic,
  beginRetirement as transitionBeginRetirement,
  armRetirement as transitionArmRetirement,
  claimWorkloads as transitionClaimWorkloads,
  completeDormantCleanup as transitionCompleteDormantCleanup,
  endTraffic as transitionEndTraffic,
  enterCapabilityCleanup as transitionEnterCapabilityCleanup,
  initializeSession,
  promoteActivationSet as transitionPromoteActivationSet,
  publicPhase,
  planIdleTimer as transitionPlanIdleTimer,
  settleLifecycleOwner,
  settleRetirementOwner,
  settleActivationTerminal as transitionSettleActivationTerminal,
  readySet as transitionReadySet,
  setRootSet as transitionSetRootSet,
  settleCapabilityCleanup as transitionSettleCapabilityCleanup,
  disarmAllRetirements as transitionDisarmAllRetirements,
  type ActivationOwner,
  type ActivationToken,
  type ActivationClaims,
  type ActivationTerminalOutcome,
  type ActivationExit,
  type ClaimedWorkload,
  type CommandResult,
  type CleanupHandle,
  type EndpointExit,
  matchesActivationOwner,
  type StartupHandle,
  type SettlementOwner,
  type SnapshotTransition,
  type TransitionNotification,
} from "./SupervisorTransitions.ts";

/** Runtime construction is injected so catalog/artifact resolution can evolve independently. */
export interface SupervisorRuntime {
  readonly driver: RuntimeDriver;
  readonly preflight: (input: LifecycleInput) => Effect.Effect<void, StackError>;
  /** Prepares artifacts before launching a newly selected workload closure. */
  readonly prepare: (
    input: LifecycleInput,
    selected: ReadonlySet<CapabilityName>,
  ) => Effect.Effect<void, StackError>;
  /** Best-effort preparation of lazy artifacts after a stack reaches running. */
  readonly prefetch: (state: PersistedStackState) => Effect.Effect<void>;
  /** Current in-memory preparation state; completed cache entries outlive the session. */
  readonly artifacts: Effect.Effect<ReadonlyArray<ArtifactPreparationStatus>>;
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
  readonly stateStore: StackStateStore;
  readonly context: Context.Context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>;
  readonly runtime: SupervisorRuntime;
};

const rpcError = (tag: StackRpcError["tag"], message: string): StackRpcError => ({ tag, message });
const credentialsUnavailable = rpcError(
  "StackNotRunningError",
  "Stack credentials are unavailable",
);
const stateErrorMessage = (error: StackError | { readonly message?: string }): string =>
  typeof error.message === "string" ? error.message : "Stack operation failed";

const sessionCleanupMessage = (error: SessionCleanupError): string => {
  const failure = Cause.findErrorOption(error.cause);
  if (Option.isSome(failure)) {
    if (failure.value instanceof RuntimeDriverError) {
      const workload =
        failure.value.workloadId === undefined ? "" : ` for ${failure.value.workloadId}`;
      return `Session cleanup is unresolved${workload}: ${failure.value.message}`;
    }
    return sessionCleanupMessage(failure.value);
  }
  const details = Cause.pretty(error.cause);
  return details.length === 0
    ? "Session cleanup is unresolved"
    : `Session cleanup is unresolved: ${details}`;
};

const credentialHost = (address: string): string =>
  address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;

const mapRuntimeError = (error: unknown): StackError => {
  if (error instanceof StackStateInvalidError) return error;
  if (error instanceof ContainerEngineError) return error;
  if (error instanceof RuntimeDriverError && isStackError(error.cause)) return error.cause;
  if (error instanceof SessionCleanupError)
    return new StackCleanupError({ message: sessionCleanupMessage(error), cause: error });
  return new StackRuntimeError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
};

const mapCleanupError = (error: unknown): StackError => {
  if (error instanceof StackStateInvalidError) return error;
  if (error instanceof SessionCleanupError)
    return new StackCleanupError({ message: sessionCleanupMessage(error), cause: error });
  return new StackCleanupError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
};

const combineCleanupOutcome = (left: CleanupOutcome, right: CleanupOutcome): CleanupOutcome =>
  Predicate.isTagged(left, "proven") && Predicate.isTagged(right, "proven")
    ? { _tag: "proven" }
    : {
        _tag: "unproven",
        cause: Cause.combine(
          Predicate.isTagged(left, "unproven") ? left.cause : Cause.empty,
          Predicate.isTagged(right, "unproven") ? right.cause : Cause.empty,
        ),
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
    const initial = yield* read().pipe(
      Effect.catchIf(isMissingStateRemnantError, () =>
        options.stateStore
          .recoverRuntimeRemnant(options.stackId)
          .pipe(Effect.provideContext(options.context), Effect.asVoid),
      ),
    );
    if (initial === undefined)
      return yield* new StackStateInvalidError({ message: "Stack state is missing" });
    const runtime = options.runtime;
    const launcher: SessionLauncher = yield* makeSessionLauncher({
      stackId: options.stackId,
      driver: runtime.driver,
    });
    const machine = yield* Ref.make<SupervisorSnapshot>({
      stack:
        initial.desiredLifecycle === "destroying"
          ? { _tag: "destroy-required", evidence: { _tag: "persisted-intent" } }
          : { _tag: "stopped", session: "uninitialized" },
      sessionId: Symbol("stack-session"),
      plan: undefined,
      capabilities: new Map(),
    });
    const currentPhase = (): Effect.Effect<ActualPhase> =>
      Ref.get(machine).pipe(Effect.map((snapshot) => publicPhase(snapshot.stack)));
    type LifecycleResult = Deferred.Deferred<Exit.Exit<void, StackError>, never>;
    type ActiveLifecycle = Readonly<{ kind: LifecycleKind; result: LifecycleResult }>;
    const activeCommand = (): Effect.Effect<ActiveLifecycle | undefined> =>
      Ref.get(machine).pipe(
        Effect.map(({ stack }) =>
          Match.value(stack).pipe(
            Match.tag("starting", "start-recovery", (state) => ({
              kind: "start" as const,
              result: state.completion,
            })),
            Match.when({ _tag: "stopping" }, (state) => ({
              kind: "stop" as const,
              result: state.completion,
            })),
            Match.when({ _tag: "destroying" }, (state) => ({
              kind: "destroy" as const,
              result: state.completion,
            })),
            Match.tag("stopped", "running", "stop-required", "destroy-required", () => undefined),
            Match.exhaustive,
          ),
        ),
      );
    type ActivationHandler = (
      capability: CapabilityName,
    ) => Effect.Effect<ActivationResult, GatewayActivationError | StackError>;
    // The ingress opens during an explicit lifecycle operation. A one-shot handoff keeps a request
    // waiting for the handler instead of exposing a construction-time race.
    const activationHandler = yield* Deferred.make<ActivationHandler, never>();
    const initializeActivationInAdmission = (input: LifecycleInput) =>
      Effect.gen(function* () {
        const eager = eagerCapabilities(input.plan);
        const startup = new Map<CapabilityName, StartupHandle>();
        for (const name of eager)
          startup.set(name, {
            completion: yield* Deferred.make<Exit.Exit<void, StackError>, never>(),
            operation: Symbol("startup"),
          });
        const sessionId = Symbol("stack-session");
        const transition = initializeSession(yield* Ref.get(machine), input, sessionId, startup);
        yield* applyTransitionInAdmission(transition);
        yield* Ref.set(
          idleTimeouts,
          new Map(
            CAPABILITY_NAMES.map((name) => [
              name,
              input.definition.capabilities[name].idleTimeoutSeconds,
            ]),
          ),
        );
      });
    const initializeActivation = (input: LifecycleInput) =>
      admission.withPermit(initializeActivationInAdmission(input));
    const resetForSession = (input: LifecycleInput) => initializeActivation(input);
    const observe = () =>
      runtime.driver.observe(options.stackId).pipe(Effect.mapError(mapRuntimeError));
    const observedForStatus = () =>
      Ref.get(machine).pipe(
        Effect.flatMap(({ stack }) => {
          const available = (workloads: ReadonlyArray<ObservedWorkload>): ObservedStatus => ({
            _tag: "available",
            workloads,
          });
          const fallback: Effect.Effect<ObservedStatus> = observe().pipe(
            Effect.map(available),
            Effect.orElseSucceed(() => ({ _tag: "unavailable" as const })),
          );
          return Match.value(stack).pipe(
            Match.when({ _tag: "stopped" }, () => Effect.succeed(available([]))),
            Match.when({ _tag: "running" }, () => observe().pipe(Effect.map(available))),
            Match.when({ _tag: "starting", prior: { _tag: "running" } }, () =>
              observe().pipe(Effect.map(available)),
            ),
            Match.when({ _tag: "starting" }, () => fallback),
            Match.when({ _tag: "stopping" }, () => fallback),
            Match.when({ _tag: "destroying" }, () => fallback),
            Match.when({ _tag: "stop-required" }, () => fallback),
            Match.when({ _tag: "start-recovery" }, () => fallback),
            Match.when({ _tag: "destroy-required" }, () => fallback),
            Match.exhaustive,
          );
        }),
      );

    const snapshot = (): Effect.Effect<StackStatus, StackError> =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        const status = yield* statusForSnapshot(
          options.stackId,
          state,
          yield* observedForStatus(),
          yield* Ref.get(machine),
          yield* runtime.artifacts,
        );
        return status;
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
    const backgroundPreparation = yield* Ref.make<Fiber.Fiber<void, never> | undefined>(undefined);
    const startBackgroundPreparation = (state: PersistedStackState): Effect.Effect<void> =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(backgroundPreparation);
        if (existing !== undefined) return;
        const fiber = yield* Effect.forkIn(runtime.prefetch(state), supervisorScope, {
          startImmediately: true,
        });
        yield* Ref.set(backgroundPreparation, fiber);
      });
    const joinExit = <A, E>(result: Exit.Exit<A, E>): Effect.Effect<A, E> =>
      Exit.isSuccess(result) ? Effect.succeed(result.value) : Effect.failCause(result.cause);
    const notify = (notification: TransitionNotification): Effect.Effect<boolean> =>
      Match.value(notification).pipe(
        Match.tag("endpoint", (value) => Deferred.succeed(value.completion, value.result)),
        Match.tag("activation", (value) => Deferred.succeed(value.completion, value.result)),
        Match.tag("stopping", (value) => Deferred.succeed(value.completion, value.result)),
        Match.tag("lifecycle", (value) => Deferred.succeed(value.completion, value.result)),
        Match.tag("workload", (value) => Deferred.succeed(value.completion, value.result)),
        Match.exhaustive,
      );
    const idleTimeouts = yield* Ref.make<ReadonlyMap<CapabilityName, number | false>>(new Map());

    const readySet = (): Effect.Effect<ReadonlySet<CapabilityName>> =>
      Ref.get(machine).pipe(
        Effect.map(
          (snapshot) =>
            new Set(
              [...snapshot.capabilities].flatMap(([name, state]) =>
                Predicate.isTagged(state, "ready") ? [name] : [],
              ),
            ),
        ),
      );
    const selectedSet = (): Effect.Effect<ReadonlySet<CapabilityName>> =>
      Ref.get(machine).pipe(
        Effect.map(
          (snapshot) =>
            new Set(
              [...snapshot.capabilities].flatMap(([name, state]) =>
                Predicate.isTagged(state, "ready") || Predicate.isTagged(state, "starting")
                  ? [name]
                  : [],
              ),
            ),
        ),
      );
    const setReadySetInAdmission = (names: ReadonlySet<CapabilityName>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const transition = transitionReadySet(yield* Ref.get(machine), names);
        yield* applyTransitionInAdmission(transition);
      });
    const setReadySet = (names: ReadonlySet<CapabilityName>): Effect.Effect<void> =>
      admission.withPermit(setReadySetInAdmission(names));
    const promoteActivationSet = (
      names: ReadonlySet<CapabilityName>,
      activationOwner: CapabilityName,
      plan: ExecutionPlan,
    ): Effect.Effect<void> =>
      admission.withPermit(
        Effect.gen(function* () {
          const transition = transitionPromoteActivationSet(
            yield* Ref.get(machine),
            names,
            activationOwner,
            plan,
          );
          yield* applyTransitionInAdmission(transition);
        }),
      );
    const claimWorkloads = (
      names: ReadonlySet<CapabilityName>,
    ): Effect.Effect<ReadonlyArray<ClaimedWorkload>> =>
      admission.withPermit(
        Effect.gen(function* () {
          const handles = new Map<CapabilityName, StartupHandle>();
          for (const name of names) {
            handles.set(name, {
              completion: yield* Deferred.make<Exit.Exit<void, StackError>, never>(),
              operation: Symbol("dependency-startup"),
            });
          }
          const transition = transitionClaimWorkloads(yield* Ref.get(machine), names, handles);
          yield* applyTransitionInAdmission(transition);
          return transition.claimed;
        }),
      );
    const settleActivationTerminalInAdmission = (
      owner: ActivationOwner,
      claims: ActivationClaims,
      outcome: ActivationTerminalOutcome,
    ): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const transition = transitionSettleActivationTerminal(
          yield* Ref.get(machine),
          owner,
          claims,
          outcome,
        );
        yield* applyTransitionInAdmission(transition);
      });
    const settleActivationTerminal = (
      owner: ActivationOwner,
      claims: ActivationClaims,
      outcome: ActivationTerminalOutcome,
    ): Effect.Effect<void, never> =>
      admission.withPermit(settleActivationTerminalInAdmission(owner, claims, outcome));
    const setRootSetInAdmission = (names: ReadonlySet<CapabilityName>): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* applyTransitionInAdmission(transitionSetRootSet(yield* Ref.get(machine), names));
      });
    const setRootSet = (names: ReadonlySet<CapabilityName>): Effect.Effect<void> =>
      admission.withPermit(setRootSetInAdmission(names));
    const enterCapabilityCleanupInAdmission = (): Effect.Effect<
      ReadonlyMap<CapabilityName, CleanupHandle>
    > =>
      Effect.gen(function* () {
        const handles = new Map<CapabilityName, CleanupHandle>();
        for (const name of CAPABILITY_NAMES)
          handles.set(name, {
            operation: Symbol("cleanup"),
            completion: yield* Deferred.make<Exit.Exit<void, StackError>, never>(),
          });
        const transition = transitionEnterCapabilityCleanup(yield* Ref.get(machine), handles);
        yield* applyTransitionInAdmission(transition);
        return handles;
      });
    const settleCapabilityCleanupInAdmission = (
      handles: ReadonlyMap<CapabilityName, CleanupHandle>,
      result: Exit.Exit<void, StackError>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const transition = transitionSettleCapabilityCleanup(
          yield* Ref.get(machine),
          result,
          handles,
        );
        yield* applyTransitionInAdmission(transition);
      });
    const completeDormantCleanupInAdmission = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* applyTransitionInAdmission(
          transitionCompleteDormantCleanup(yield* Ref.get(machine)),
        );
      });
    const completeDormantCleanup = (): Effect.Effect<void> =>
      admission.withPermit(completeDormantCleanupInAdmission());
    const appendIdleLog = (message: string): Effect.Effect<void> =>
      options.runtime.logStore
        .append({
          source: "supervisor",
          stream: "internal",
          message,
        })
        .pipe(
          Effect.catchTag("LogStoreError", (error) => Effect.logWarning(message, error)),
          Effect.asVoid,
        );

    function retireIdle(
      capability: CapabilityName,
      epoch: symbol,
    ): Effect.Effect<boolean, StackError> {
      return execution.withPermit(
        Effect.gen(function* () {
          const completion = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
          const operation = Symbol("retirement");
          const retire = Effect.gen(function* () {
            const fenced = yield* admission.withPermit(
              Effect.gen(function* () {
                const snapshot = yield* Ref.get(machine);
                const transition = transitionBeginRetirement(
                  snapshot,
                  capability,
                  operation,
                  completion,
                  epoch,
                );
                yield* applyTransitionInAdmission(transition);
                return transition.admitted;
              }),
            );
            if (!fenced) return false;
            yield* launcher
              .stopCapabilities(new Set([capability]))
              .pipe(Effect.mapError(mapCleanupError));
            return true;
          }).pipe(
            Effect.onExit((result) =>
              settleOwner({
                _tag: "retirement",
                capability,
                operation,
                completion,
                result,
              }),
            ),
          );
          const stopped = yield* Effect.exit(retire);
          if (Exit.isFailure(stopped)) {
            const logged = yield* appendIdleLog(
              `Failed to stop ${capability} after inactivity: ${Cause.pretty(stopped.cause)}`,
            ).pipe(Effect.exit);
            if (Exit.isFailure(logged))
              return yield* Effect.failCause(Cause.combine(stopped.cause, logged.cause));
            if (Cause.hasInterrupts(stopped.cause) || Cause.hasDies(stopped.cause))
              return yield* Effect.failCause(stopped.cause);
            return false;
          }
          if (!stopped.value) return false;

          yield* appendIdleLog(`Stopped ${capability} after inactivity`);
          return true;
        }),
      );
    }

    function armIdleTimerInAdmission(capability: CapabilityName): Effect.Effect<void> {
      return Effect.gen(function* () {
        const snapshot = yield* Ref.get(machine);
        const timeouts = yield* Ref.get(idleTimeouts);
        const plan = transitionPlanIdleTimer(snapshot, timeouts, capability);
        if (plan === undefined) return;
        const token = Symbol();
        yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const started = yield* Deferred.make<void, never>();
            const fiber = yield* Effect.forkIn(
              Deferred.await(started).pipe(
                Effect.andThen(
                  Effect.sleep(Duration.seconds(plan.timeout)).pipe(
                    Effect.andThen(
                      FiberSet.run(ownedFibers, retireIdle(capability, token), {
                        startImmediately: true,
                      }).pipe(Effect.asVoid),
                    ),
                  ),
                ),
              ),
              supervisorScope,
              { startImmediately: true },
            );
            const transition = transitionArmRetirement(snapshot, plan, token, fiber);
            yield* applyTransitionInAdmission(transition);
            yield* Deferred.succeed(started, undefined);
          }),
        );
      });
    }

    function reevaluateIdleTimersInAdmission(): Effect.Effect<void> {
      return readySet().pipe(
        Effect.flatMap((capabilities) =>
          Effect.forEach(capabilities, armIdleTimerInAdmission, {
            discard: true,
          }),
        ),
      );
    }

    function armIdleTimer(capability: CapabilityName): Effect.Effect<void> {
      return admission.withPermit(armIdleTimerInAdmission(capability));
    }

    const cancelIdleTimers: Effect.Effect<void> = Effect.gen(function* () {
      const timers = yield* admission.withPermit(
        Effect.gen(function* () {
          const snapshot = yield* Ref.get(machine);
          const transition = transitionDisarmAllRetirements(snapshot);
          yield* applyTransitionInAdmission(transition);
          return transition.timers;
        }),
      );
      yield* Effect.forEach(timers, (fiber) => Fiber.interrupt(fiber), {
        concurrency: "unbounded",
        discard: true,
      });
    });

    type TrafficLease = Readonly<{ readonly sessionId: symbol }>;
    const beginTraffic = (capability: CapabilityName): Effect.Effect<TrafficLease> =>
      Effect.gen(function* () {
        const acquired = yield* admission.withPermit(
          Effect.gen(function* () {
            const snapshot = yield* Ref.get(machine);
            const transition = transitionBeginTraffic(snapshot, capability);
            yield* applyTransitionInAdmission(transition);
            return { fiber: transition.timer, lease: { sessionId: snapshot.sessionId } };
          }),
        );
        if (acquired.fiber !== undefined) yield* Fiber.interrupt(acquired.fiber);
        return acquired.lease;
      });
    const endTraffic = (capability: CapabilityName, lease: TrafficLease): Effect.Effect<void> =>
      Effect.gen(function* () {
        const shouldArm = yield* admission.withPermit(
          Effect.gen(function* () {
            const snapshot = yield* Ref.get(machine);
            const transition = transitionEndTraffic(snapshot, capability, lease.sessionId);
            yield* applyTransitionInAdmission(transition);
            return transition.shouldArm;
          }),
        );
        if (shouldArm) yield* armIdleTimer(capability);
      });

    const activity = yield* makeGatewayActivity({ begin: beginTraffic, end: endTraffic });
    const ingressActivate = (
      capability: CapabilityName,
    ): Effect.Effect<ActivationResult, GatewayActivationError | StackError> =>
      Effect.gen(function* () {
        // A request can reach the adopted gateway while the owning start operation is still
        // installing its workloads. Wait for that shared lifecycle result before attempting lazy
        // activation; otherwise the state check below would turn a valid cold request into 503.
        const lifecycle = yield* activeCommand();
        if (lifecycle?.kind === "start") {
          const started = yield* Deferred.await(lifecycle.result);
          yield* joinExit(started);
        }
        const handler = yield* Deferred.await(activationHandler);
        return yield* handler(capability);
      });
    const ensureActivationStateAllowed = (): Effect.Effect<
      PersistedStackState,
      GatewayActivationError | StackError
    > =>
      Effect.gen(function* () {
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
      effect: Effect.Effect<CommandResult, StackError>,
    ): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        const owned = yield* admission.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* ensureAcceptingOperations;
              const deferred = yield* Deferred.make<Exit.Exit<void, StackError>, never>();
              const snapshot = yield* Ref.get(machine);
              const admitted = admitLifecycle(snapshot, kind, deferred, Symbol(kind));
              if (Predicate.isTagged(admitted, "rejected"))
                return yield* new StackLifecycleConflictError({
                  stackId: options.stackId,
                  message:
                    admitted.reason === "stop-required"
                      ? "Exact runtime cleanup is required; retry stop before starting"
                      : admitted.reason === "destroy-required"
                        ? "Destructive cleanup is required; retry destroy before proceeding"
                        : `Lifecycle operation ${admitted.activeKind ?? kind} is already active`,
                  recovery:
                    admitted.reason === "stop-required" || admitted.reason === "destroy-required"
                      ? recoveryForState(snapshot.stack)
                      : undefined,
                });
              yield* applyTransitionInAdmission(admitted);
              const finish = (result: Exit.Exit<CommandResult, StackError>) =>
                Effect.gen(function* () {
                  const operation = Exit.isSuccess(result)
                    ? result.value
                    : {
                        _tag: "failed" as const,
                        cause: result.cause,
                        cleanup: { _tag: "unproven" as const, cause: result.cause },
                        durable: "unsafe" as const,
                      };
                  yield* settleOwner({
                    _tag: "lifecycle",
                    completion: deferred,
                    result: operation,
                  });
                  return operation;
                });
              const owner = Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const cancelled = yield* restore(cancelIdleTimers).pipe(Effect.exit);
                  if (Exit.isFailure(cancelled)) {
                    yield* finish(Exit.failCause(cancelled.cause));
                    return yield* Effect.failCause(cancelled.cause);
                  }
                  const acquired = yield* restore(execution.take(1)).pipe(Effect.exit);
                  if (Exit.isFailure(acquired)) {
                    yield* finish(Exit.failCause(acquired.cause));
                    return yield* Effect.failCause(acquired.cause);
                  }
                  return yield* Effect.ensuring(
                    Effect.gen(function* () {
                      const result = yield* restore(effect).pipe(Effect.exit);
                      const operation = yield* finish(result);
                      return yield* joinExit(
                        Predicate.isTagged(operation, "failed")
                          ? Exit.failCause(operation.cause)
                          : Exit.succeed(operation),
                      );
                    }),
                    execution.release(1),
                  );
                }),
              );
              const ownerFiber = yield* FiberSet.run(ownedFibers, owner, {
                startImmediately: true,
              });
              // Effect rc112 has no safe Fiber.poll; FiberSet returns an already-interrupted fiber when closed.
              const ownerExit = yield* Effect.sync(() => ownerFiber.pollUnsafe());
              if (
                ownerExit !== undefined &&
                Exit.isFailure(ownerExit) &&
                Cause.hasInterruptsOnly(ownerExit.cause)
              ) {
                const conflict = new StackLifecycleConflictError({
                  stackId: options.stackId,
                  message: "Stack owner scope is closed",
                });
                const cause = Cause.fail(conflict);
                yield* settleOwnerInAdmission({
                  _tag: "lifecycle",
                  completion: deferred,
                  result: {
                    _tag: "failed",
                    cause,
                    cleanup: { _tag: "unproven", cause },
                    durable: "unsafe",
                  },
                });
              }
              return deferred;
            }),
          ),
        );
        return yield* joinExit(yield* Deferred.await(owned));
      });

    const launchBackend = (
      input: LifecycleInput,
      session: "fresh" | "current",
      selectedOverride?: ReadonlySet<CapabilityName>,
    ): Effect.Effect<LifecycleLaunchResult, StackError> =>
      Effect.gen(function* () {
        if (session === "fresh") yield* resetForSession(input);
        const selected = selectedOverride ?? (yield* selectedSet());
        const plan = activeExecutionPlan(input.plan, selected);
        const reservation = yield* runtime.ingress.acquire(input);
        const launchCancellation = yield* Deferred.make<void>();
        const preparedFiber = yield* Effect.forkChild(
          runtime.prepare(input, selected).pipe(Effect.exit),
          {
            startImmediately: true,
          },
        );
        const launchFiber = yield* Effect.forkChild(launcher.launch(plan, launchCancellation), {
          startImmediately: true,
        });
        const first = yield* Effect.raceFirst(
          Fiber.await(preparedFiber).pipe(
            Effect.map((value) => ({ _tag: "prepared", value }) as const),
          ),
          Fiber.await(launchFiber).pipe(
            Effect.map((value) => ({ _tag: "launch", value }) as const),
          ),
        );
        let prepared: Exit.Exit<void, StackError>;
        let launch: SessionLaunchOutcome;
        const preparedExit = (value: Exit.Exit<Exit.Exit<void, StackError>, never>) =>
          Exit.isSuccess(value) ? value.value : Exit.failCause(value.cause);
        const launchOutcome = (
          value: Exit.Exit<SessionLaunchOutcome, never>,
        ): SessionLaunchOutcome =>
          Exit.isSuccess(value)
            ? value.value
            : {
                _tag: "failed",
                cause: value.cause,
                cleanup: { _tag: "unproven", cause: value.cause },
              };
        if (Predicate.isTagged(first, "prepared")) {
          prepared = preparedExit(first.value);
          if (Exit.isFailure(prepared)) yield* Deferred.succeed(launchCancellation, undefined);
          launch = launchOutcome(yield* Fiber.await(launchFiber));
        } else {
          launch = launchOutcome(first.value);
          if (Predicate.isTagged(launch, "failed")) {
            yield* Fiber.interrupt(preparedFiber);
            prepared = preparedExit(yield* Fiber.await(preparedFiber));
          } else {
            prepared = preparedExit(yield* Fiber.await(preparedFiber));
          }
        }
        const mapSessionCleanup = (cleanup: SessionCleanupOutcome): CleanupOutcome =>
          Match.value(cleanup).pipe(
            Match.when({ _tag: "proven" }, () => ({ _tag: "proven" as const })),
            Match.when({ _tag: "unproven" }, (value) => ({
              _tag: "unproven" as const,
              cause: Cause.map(value.cause, mapRuntimeError),
            })),
            Match.exhaustive,
          );
        if (Exit.isFailure(prepared)) {
          const closed = reservation.fresh
            ? yield* runtime.ingress.close.pipe(Effect.mapError(mapRuntimeError), Effect.exit)
            : Exit.succeed(undefined);
          let cause: Cause.Cause<StackError> = Cause.map(prepared.cause, mapRuntimeError);
          let workloadCleanup: CleanupOutcome = { _tag: "proven" };
          if (Predicate.isTagged(launch, "started")) {
            workloadCleanup = mapSessionCleanup(yield* launch.launch.rollback);
            if (Predicate.isTagged(workloadCleanup, "unproven"))
              cause = Cause.combine(cause, workloadCleanup.cause);
          } else {
            const launchCause = Cause.map(launch.cause, mapRuntimeError);
            cause = Cause.combine(cause, launchCause);
            workloadCleanup = mapSessionCleanup(launch.cleanup);
          }
          const closedCleanup: CleanupOutcome = Exit.isFailure(closed)
            ? { _tag: "unproven", cause: closed.cause }
            : { _tag: "proven" };
          const cleanup = combineCleanupOutcome(workloadCleanup, closedCleanup);
          if (Predicate.isTagged(closedCleanup, "unproven"))
            cause = Cause.combine(cause, closedCleanup.cause);
          return {
            _tag: "failed",
            cause,
            cleanup,
          } satisfies LifecycleLaunchResult;
        }
        if (Predicate.isTagged(launch, "failed")) {
          const closed = reservation.fresh
            ? yield* runtime.ingress.close.pipe(Effect.mapError(mapRuntimeError), Effect.exit)
            : Exit.succeed(undefined);
          const launchCause = Cause.map(launch.cause, mapRuntimeError);
          let cause: Cause.Cause<StackError> = launchCause;
          const workloadCleanup = mapSessionCleanup(launch.cleanup);
          const closedCleanup: CleanupOutcome = Exit.isFailure(closed)
            ? { _tag: "unproven", cause: closed.cause }
            : { _tag: "proven" };
          const cleanup = combineCleanupOutcome(workloadCleanup, closedCleanup);
          if (Predicate.isTagged(closedCleanup, "unproven"))
            cause = Cause.combine(cause, closedCleanup.cause);
          return {
            _tag: "failed",
            cause,
            cleanup,
          } satisfies LifecycleLaunchResult;
        }
        const rollback: Effect.Effect<CleanupOutcome> = Effect.gen(function* () {
          const workload = yield* launch.launch.rollback;
          const closed = reservation.fresh
            ? yield* runtime.ingress.close.pipe(Effect.mapError(mapRuntimeError), Effect.exit)
            : Exit.succeed(undefined);
          const workloadOutcome = mapSessionCleanup(workload);
          const closedOutcome: CleanupOutcome = Exit.isSuccess(closed)
            ? { _tag: "proven" }
            : { _tag: "unproven", cause: closed.cause };
          return combineCleanupOutcome(workloadOutcome, closedOutcome);
        });
        const opened = yield* runtime.ingress
          .open(input, reservation, ingressActivate, activity)
          .pipe(Effect.exit);
        if (Exit.isFailure(opened)) {
          const rolledBack = yield* rollback;
          const cause = Predicate.isTagged(rolledBack, "unproven")
            ? Cause.combine(opened.cause, rolledBack.cause)
            : opened.cause;
          return {
            _tag: "failed",
            cause,
            cleanup: rolledBack,
          } satisfies LifecycleLaunchResult;
        }
        return { _tag: "started", rollback } satisfies LifecycleLaunchResult;
      });

    const cleanupRuntime = (destroy: boolean): Effect.Effect<void, StackError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const admissionPermit = yield* restore(admission.take(1)).pipe(Effect.exit);
          if (Exit.isFailure(admissionPermit))
            return yield* Effect.failCause(admissionPermit.cause);
          const entered = yield* Effect.uninterruptibleMask(() =>
            enterCapabilityCleanupInAdmission().pipe(Effect.ensuring(admission.release(1))),
          ).pipe(Effect.exit);
          if (Exit.isFailure(entered)) return yield* Effect.failCause(entered.cause);
          const handles = entered.value;
          const result = yield* restore(
            Effect.gen(function* () {
              const background = yield* Ref.get(backgroundPreparation);
              if (background !== undefined) yield* Fiber.interrupt(background);
              yield* Ref.set(backgroundPreparation, undefined);
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
              for (const outcome of [ingress, launched, driver])
                if (Exit.isFailure(outcome)) cause = Cause.combine(cause, outcome.cause);
              if (cause.reasons.length > 0) return yield* Effect.failCause(cause);
            }),
          ).pipe(Effect.exit);
          yield* admission.withPermit(settleCapabilityCleanupInAdmission(handles, result));
          if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
          yield* completeDormantCleanup();
          if (destroy) yield* launcher.clear;
          yield* setRootSet(new Set());
        }),
      );
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

    type PreparedActivation = Readonly<{
      readonly input: LifecycleInput;
      readonly selected: ReadonlySet<CapabilityName>;
    }>;
    const prepareActivation = (
      owner: ActivationOwner,
    ): Effect.Effect<PreparedActivation, GatewayActivationError | StackError> =>
      Effect.gen(function* () {
        const state = yield* ensureActivationStateAllowed();
        const definition = state.definition;
        if (definition === undefined || !definition.capabilities[owner.capability].enabled)
          return yield* new GatewayActivationError({
            message: `Capability ${owner.capability} is not enabled`,
          });
        const plan = yield* rebuildExecutionPlan(state.runtime, definition).pipe(
          Effect.provideContext(options.context),
          Effect.mapError(
            (error) => new StackStateInvalidError({ message: error.message, cause: error }),
          ),
        );
        return {
          input: {
            stackId: options.stackId,
            state,
            definition,
            secrets: state.secrets,
            plan,
          },
          selected: new Set([
            ...(yield* readySet()),
            ...dependencyClosure(plan, [owner.capability]),
          ]),
        };
      });

    const runActivationOwner = (owner: ActivationOwner): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiber = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const acquired = yield* restore(execution.take(1)).pipe(Effect.exit);
            if (Exit.isFailure(acquired)) {
              yield* settleActivationTerminal(
                owner,
                { _tag: "none" },
                {
                  _tag: "failed",
                  cause: acquired.cause,
                  cleanup: { _tag: "proven" },
                },
              );
              return yield* Effect.failCause(acquired.cause);
            }
            return yield* Effect.ensuring(
              Effect.gen(function* () {
                const fence = yield* admission.withPermit(
                  Effect.gen(function* () {
                    const snapshot = yield* Ref.get(machine);
                    return {
                      ownerMatches: matchesActivationOwner(snapshot, owner),
                      gate: activationGate(snapshot, options.stackId),
                    };
                  }),
                );
                if (!fence.ownerMatches) {
                  const conflict = new StackLifecycleConflictError({
                    stackId: options.stackId,
                    message: Predicate.isTagged(owner, "endpoint")
                      ? "Endpoint activation was superseded by a lifecycle transition"
                      : "Lazy activation was superseded by a lifecycle transition",
                  });
                  yield* settleActivationTerminal(
                    owner,
                    { _tag: "none" },
                    {
                      _tag: "failed",
                      cause: Cause.fail(conflict),
                      cleanup: { _tag: "proven" },
                    },
                  );
                  return yield* conflict;
                }
                if (Predicate.isTagged(fence.gate, "rejected")) {
                  yield* settleActivationTerminal(
                    owner,
                    { _tag: "none" },
                    {
                      _tag: "failed",
                      cause: Cause.fail(fence.gate.error),
                      cleanup: { _tag: "proven" },
                    },
                  );
                  return yield* fence.gate.error;
                }
                const prepared = yield* restore(prepareActivation(owner)).pipe(Effect.exit);
                if (Exit.isFailure(prepared)) {
                  yield* settleActivationTerminal(
                    owner,
                    { _tag: "none" },
                    {
                      _tag: "failed",
                      cause: prepared.cause,
                      cleanup: { _tag: "proven" },
                    },
                  );
                  return yield* Effect.failCause(prepared.cause);
                }
                const claimed = yield* claimWorkloads(prepared.value.selected).pipe(Effect.exit);
                if (Exit.isFailure(claimed)) {
                  yield* settleActivationTerminal(
                    owner,
                    { _tag: "none" },
                    {
                      _tag: "failed",
                      cause: claimed.cause,
                      cleanup: { _tag: "unproven", cause: claimed.cause },
                    },
                  );
                  return yield* Effect.failCause(claimed.cause);
                }
                const claims: ActivationClaims = {
                  _tag: "claimed",
                  claimed: claimed.value,
                  affected: prepared.value.selected,
                };
                const attempt = yield* restore(
                  Effect.gen(function* () {
                    const launched = yield* launchBackend(
                      prepared.value.input,
                      "current",
                      prepared.value.selected,
                    ).pipe(Effect.exit);
                    if (Exit.isFailure(launched))
                      return {
                        _tag: "failed" as const,
                        cause: launched.cause,
                        cleanup: { _tag: "unproven" as const, cause: launched.cause },
                      } satisfies ActivationTerminalOutcome;
                    if (Predicate.isTagged(launched.value, "failed"))
                      return {
                        _tag: "failed" as const,
                        cause: launched.value.cause,
                        cleanup: launched.value.cleanup,
                      } satisfies ActivationTerminalOutcome;
                    yield* setReadySet(prepared.value.selected);
                    const activated = yield* runtime
                      .activate(owner.capability, prepared.value.input)
                      .pipe(Effect.exit);
                    if (Exit.isFailure(activated)) {
                      const rolledBack = yield* launched.value.rollback;
                      const cause = Predicate.isTagged(rolledBack, "unproven")
                        ? Cause.combine(activated.cause, rolledBack.cause)
                        : activated.cause;
                      return {
                        _tag: "failed" as const,
                        cause,
                        cleanup: rolledBack,
                      } satisfies ActivationTerminalOutcome;
                    }
                    yield* promoteActivationSet(
                      prepared.value.selected,
                      owner.capability,
                      prepared.value.input.plan,
                    );
                    return {
                      _tag: "succeeded" as const,
                      value: { capability: owner.capability, endpoint: activated.value },
                    } satisfies ActivationTerminalOutcome;
                  }),
                ).pipe(
                  Effect.onExit((result) =>
                    settleActivationTerminal(
                      owner,
                      claims,
                      Exit.isSuccess(result)
                        ? result.value
                        : {
                            _tag: "failed",
                            cause: result.cause,
                            cleanup: { _tag: "unproven", cause: result.cause },
                          },
                    ),
                  ),
                  Effect.exit,
                );
                if (Exit.isFailure(attempt)) return yield* Effect.failCause(attempt.cause);
                if (Predicate.isTagged(attempt.value, "failed"))
                  return yield* Effect.failCause(attempt.value.cause);
                return attempt.value.value;
              }),
              execution.release(1),
            );
          }),
        );
        const ownerFiber = yield* FiberSet.run(ownedFibers, fiber, { startImmediately: true });
        const ownerExit = yield* Effect.sync(() => ownerFiber.pollUnsafe());
        if (
          ownerExit !== undefined &&
          Exit.isFailure(ownerExit) &&
          Cause.hasInterruptsOnly(ownerExit.cause)
        )
          yield* settleActivationTerminalInAdmission(
            owner,
            { _tag: "none" },
            {
              _tag: "failed",
              cause: Cause.fail(
                new StackLifecycleConflictError({
                  stackId: options.stackId,
                  message: "Stack owner scope is closed",
                }),
              ),
              cleanup: { _tag: "proven" },
            },
          );
      });
    const applyTransitionInAdmission = (transition: SnapshotTransition): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.set(machine, transition.snapshot);
        if (transition.reconcile === "all-ready") yield* reevaluateIdleTimersInAdmission();
        yield* Effect.forEach(transition.notifications, notify, { discard: true });
      });
    const settleOwnerInAdmission = (owner: SettlementOwner): Effect.Effect<void> =>
      Effect.gen(function* () {
        const snapshot = yield* Ref.get(machine);
        const settlement = Match.value(owner).pipe(
          Match.when({ _tag: "lifecycle" }, (event) => settleLifecycleOwner(snapshot, event)),
          Match.when({ _tag: "retirement" }, (event) => settleRetirementOwner(snapshot, event)),
          Match.exhaustive,
        );
        yield* applyTransitionInAdmission(settlement);
      });
    const settleOwner = (owner: SettlementOwner): Effect.Effect<void> =>
      admission.withPermit(settleOwnerInAdmission(owner));
    const activate: Supervisor["activate"] = (capability) =>
      Effect.gen(function* () {
        const token = yield* admission.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const endpoint = yield* Deferred.make<EndpointExit, never>();
              const activation = yield* Deferred.make<ActivationExit, never>();
              const decision = admitActivation(
                yield* Ref.get(machine),
                capability,
                options.stackId,
                endpoint,
                activation,
                Symbol("activation"),
              );
              if (Predicate.isTagged(decision, "rejected")) return yield* decision.error;
              if (Predicate.isTagged(decision, "respond")) return decision.token;
              yield* applyTransitionInAdmission(decision.snapshot);
              yield* runActivationOwner(decision.owner);
              return Predicate.isTagged(decision, "endpoint-owner")
                ? ({
                    _tag: "endpoint",
                    capability,
                    result: decision.owner.endpoint,
                  } satisfies ActivationToken)
                : ({
                    _tag: "deferred",
                    result: decision.owner.completion,
                  } satisfies ActivationToken);
            }),
          ),
        );
        return yield* Match.value(token).pipe(
          Match.when({ _tag: "deferred" }, (event) =>
            Deferred.await(event.result).pipe(Effect.flatMap(joinExit)),
          ),
          Match.when({ _tag: "await" }, (event) =>
            Effect.gen(function* () {
              const completed = yield* Deferred.await(event.result);
              if (Exit.isFailure(completed)) return yield* Effect.failCause(completed.cause);
              return yield* activate(capability);
            }),
          ),
          Match.when({ _tag: "endpoint" }, (event) =>
            Deferred.await(event.result).pipe(
              Effect.flatMap(joinExit),
              Effect.map((endpoint) => ({ capability: event.capability, endpoint })),
            ),
          ),
          Match.when({ _tag: "exit" }, (event) => joinExit(event.result)),
          Match.exhaustive,
        );
      });
    yield* Deferred.succeed(activationHandler, activate);

    const startOperation = (startOptions?: {
      readonly config?: StackConfig;
    }): Effect.Effect<CommandResult, StackError> =>
      Effect.gen(function* () {
        const admitted = (yield* Ref.get(machine)).stack;
        if (Predicate.isTagged(admitted, "start-recovery"))
          return {
            _tag: "failed",
            cause: admitted.cause,
            cleanup: { _tag: "unproven", cause: admitted.cause },
            durable: "unsafe",
          } satisfies CommandResult;
        const freshSession =
          Predicate.isTagged(admitted, "starting") &&
          Predicate.isTagged(admitted.prior, "stopped") &&
          admitted.prior.session === "uninitialized";
        if (freshSession) {
          const cleaned = yield* backend.cleanup.pipe(Effect.exit);
          if (Exit.isFailure(cleaned)) {
            return yield* Effect.failCause(cleaned.cause);
          }
        }
        const started = yield* controller
          .start({
            config: startOptions?.config,
            freshSession,
          })
          .pipe(Effect.provideContext(options.context), Effect.exit);
        if (Exit.isFailure(started)) {
          return {
            _tag: "failed",
            cause: started.cause,
            cleanup: { _tag: "unproven", cause: started.cause },
            durable: "unsafe",
          } satisfies CommandResult;
        }
        if (Predicate.isTagged(started.value, "failed")) {
          return {
            _tag: "failed",
            cause: started.value.cause,
            cleanup: started.value.cleanup,
            durable: started.value.durable,
          } satisfies CommandResult;
        }
        yield* setReadySet(yield* selectedSet());
        yield* startBackgroundPreparation(started.value.state);
        return { _tag: "succeeded" } satisfies CommandResult;
      });
    const start = (startOptions?: { readonly config?: StackConfig }) =>
      Effect.gen(function* () {
        yield* submitLifecycle("start", startOperation(startOptions));
        return yield* snapshot();
      });
    const stopOperation = (): Effect.Effect<CommandResult, StackError> =>
      Effect.gen(function* () {
        const result = yield* controller.stop.pipe(
          Effect.provideContext(options.context),
          Effect.exit,
        );
        if (Exit.isFailure(result))
          return {
            _tag: "failed",
            cause: result.cause,
            cleanup: { _tag: "unproven", cause: result.cause },
            durable: "unsafe",
          } satisfies CommandResult;
        return { _tag: "succeeded" } satisfies CommandResult;
      });
    const signalShutdownIfIdle = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const lifecycle = yield* activeCommand();
        if (lifecycle !== undefined) {
          yield* Deferred.await(lifecycle.result);
          return yield* signalShutdownIfIdle();
        }
        yield* admission.withPermit(
          Effect.gen(function* () {
            // Recheck ownership after admission: a lifecycle may have started between the
            // initial observation and this critical section. Keep the permit while making the
            // final state/phase decision and signalling shutdown so no new start can slip in.
            if ((yield* activeCommand()) !== undefined) return;
            const state = yield* read().pipe(Effect.exit);
            if (Exit.isFailure(state)) return;
            const machineState = (yield* Ref.get(machine)).stack;
            if (
              Predicate.isTagged(machineState, "stopped") &&
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
    const destroyOperation: Effect.Effect<CommandResult, StackError> = Effect.gen(function* () {
      const result = yield* controller.destroy.pipe(
        Effect.provideContext(options.context),
        Effect.exit,
      );
      if (Exit.isFailure(result))
        return {
          _tag: "failed",
          cause: result.cause,
          cleanup: { _tag: "unproven", cause: result.cause },
          durable: "unsafe",
        } satisfies CommandResult;
      return { _tag: "succeeded" } satisfies CommandResult;
    });
    const destroy = submitLifecycle("destroy", destroyOperation).pipe(Effect.asVoid);
    const logs = (query?: LogQuery): Effect.Effect<StackLogBatch, StackError> =>
      Effect.gen(function* () {
        // Capture lifecycle phase before reading the log store. A stopping snapshot stays live
        // and gives followers one more poll rather than racing a final batch.
        const phaseAtRead = yield* currentPhase();
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
        rpcRelease: STACK_RPC_RELEASE,
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
        const actualPhase = yield* currentPhase();
        if (
          state === undefined ||
          actualPhase !== "running" ||
          state.desiredLifecycle !== "running"
        )
          return yield* Effect.fail(credentialsUnavailable);

        const definition = state.definition;
        const databaseListener = definition?.listeners.database;
        const databaseAssignment = state.ports.find(({ field }) => field === "database");
        if (definition === undefined)
          return yield* Effect.fail(
            rpcError("InvalidStackConfigError", "Stack credentials require a stack definition"),
          );
        if (
          databaseListener === undefined ||
          !databaseListener.enabled ||
          databaseAssignment === undefined
        )
          return yield* Effect.fail(
            rpcError(
              "InvalidStackConfigError",
              "Stack credentials require an enabled database listener and assigned database port",
            ),
          );

        const requiredSecret = (slot: string): Effect.Effect<string, StackRpcError> => {
          const value = state.secrets[slot]?.value;
          return value === undefined || value.length === 0
            ? Effect.fail(
                rpcError("StackSecretMismatchError", "Required stack credential is unavailable"),
              )
            : Effect.succeed(value);
        };

        const databasePassword = yield* requiredSecret(DATABASE_INTERNAL_PASSWORD_SLOT);
        const databaseHost = credentialHost(databaseListener.address);
        const databaseUrl = `postgresql://${encodeURIComponent("postgres")}:${encodeURIComponent(
          databasePassword,
        )}@${databaseHost}:${databaseAssignment.port}/postgres`;

        const auth = definition.capabilities.auth;
        const api = auth.enabled
          ? yield* Effect.gen(function* () {
              const publishableKey = yield* requiredSecret(AUTH_PUBLISHABLE_KEY_SLOT);
              const secretKey = yield* requiredSecret(AUTH_SECRET_KEY_SLOT);
              const anonJwt = yield* requiredSecret(AUTH_ANON_KEY_SLOT);
              const serviceRoleJwt = yield* requiredSecret(AUTH_SERVICE_ROLE_KEY_SLOT);
              return {
                publishableKey,
                secretKey: Redacted.make(secretKey),
                anonJwt,
                serviceRoleJwt: Redacted.make(serviceRoleJwt),
              };
            })
          : undefined;

        const base: EffectStackCredentials = {
          database: {
            url: Redacted.make(databaseUrl),
            password: Redacted.make(databasePassword),
          },
          ...(api === undefined ? {} : { api }),
        };
        const storage = definition.capabilities.storage;
        const s3 = storage.settings.s3_protocol;
        if (!storage.enabled || s3 === null || s3 === undefined || s3.enabled !== true) return base;

        const apiListener = definition.listeners.api;
        const apiAssignment = state.ports.find(({ field }) => field === "api");
        if (apiListener === undefined || !apiListener.enabled || apiAssignment === undefined)
          return yield* Effect.fail(
            rpcError(
              "InvalidStackConfigError",
              "Stack credentials require an enabled API listener and assigned API port",
            ),
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
