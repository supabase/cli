import {
  Context,
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  FiberSet,
  Path,
  Redacted,
  Ref,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from "effect";
import type { StackIdentity } from "../identity/Identity.ts";
import { canonicalize, compileStack, rebuildExecutionPlan } from "../model/Compiler.ts";
import type { ExecutionPlan, PlannedWorkload } from "../model/ExecutionPlan.ts";
import {
  CAPABILITY_NAMES,
  type CapabilityName,
  type CapabilityStatus,
} from "../public/Capability.ts";
import { StackConfigSchema, type StackConfig } from "../public/Config.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import {
  GatewayActivationError,
  InvalidStackIdentityError,
  InvalidProjectRootError,
  InvalidStackConfigError,
  StackDefinitionRequiredError,
  StackLifecycleConflictError,
  StackNotFoundError,
  StackNotRunningError,
  StackMustBeStoppedError,
  StackOwnershipConflictError,
  StackRuntimeMismatchError,
  StackReconciliationError,
  StackVersionUnsupportedError,
  StackStateFormatUnsupportedError,
  StackUpgradeRequiredError,
  StackUpgradeReplacementError,
  StackStateGenerationMismatchError,
  StackSecretMismatchError,
  InvalidJwtSigningMaterialError,
  PortAllocationError,
  PortUnavailableError,
  ServiceStartError,
  ServiceReadinessError,
  ContainerEngineError,
  StackDestructionError,
  GatewayAuthenticationError,
  GatewayStaleGenerationError,
  StackPreparationError,
  ArtifactIntegrityError,
  ContainerPullError,
  StackStateInvalidError,
  type StackError,
} from "../public/Errors.ts";
import type { StackEndpoint, StackStatus } from "../public/Status.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import type { LogOptions, StackLogEntry } from "../public/Logs.ts";
import type { EffectStackCredentials } from "../public/Credentials.ts";
import type {
  RuntimeDriver,
  RuntimeRecoveryRequest,
  ObservedWorkload,
} from "../runtime/RuntimeDriver.ts";
import { RuntimeDriverError, RuntimeGenerationMismatchError } from "../runtime/RuntimeDriver.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { makeReconciler, type Reconciler } from "./Reconciler.ts";
import {
  makeLifecycleController,
  type LifecycleBackend,
  type LifecycleInput,
  type LifecyclePrepared,
} from "./Lifecycle.ts";
import { makeStatusHub } from "./StatusHub.ts";
import type { LogStore } from "./LogStore.ts";
import type { SupervisorIngress } from "./Ingress.ts";
import { StackRpcGroup, type StackRpcError, type StackRpcHandlers } from "../control/StackRpc.ts";
import type { MaintenanceResponse } from "../control/MaintenanceProtocol.ts";
import type { PreparedWorkloadArtifact } from "../preparation/RuntimeArtifacts.ts";

interface ActivationResult {
  readonly capability: CapabilityName;
  readonly endpoint: { readonly host: string; readonly port: number };
}

/** Runtime construction is injected so catalog/artifact resolution can evolve independently. */
export interface SupervisorRuntime {
  readonly driver: RuntimeDriver;
  /** Verifies and prepares immutable workload artifacts without changing lifecycle state. */
  readonly prepare?: (
    runtime: StackRuntime,
    workloads: ReadonlyArray<PlannedWorkload>,
  ) => Effect.Effect<ReadonlyArray<PreparedWorkloadArtifact>, StackError>;
  readonly preflight?: (input: LifecycleInput) => Effect.Effect<LifecyclePrepared, StackError>;
  readonly activate?: (
    capability: CapabilityName,
    input: LifecycleInput,
  ) => Effect.Effect<ActivationResult["endpoint"], GatewayActivationError | StackError>;
  /** Optional Supervisor-owned public ingress and lazy route activation lifecycle. */
  readonly ingress?: SupervisorIngress;
  readonly logStore?: LogStore;
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
  readonly restart: (options?: {
    readonly config?: StackConfig;
  }) => Effect.Effect<StackStatus, StackError>;
  readonly destroy: Effect.Effect<void, StackError>;
  /** Completes persisted-running recovery for a deferred owner session. */
  readonly recover: Effect.Effect<void>;
  /** Completes after a successful destroy or quiesce shutdown signal. */
  readonly shutdown: Effect.Effect<void>;
  /** Signals owner shutdown after accepted quiesce or a successful destroy response. */
  readonly signalShutdown: Effect.Effect<void>;
  readonly watchStatus: Stream.Stream<StackStatus, StackError>;
  readonly logs: (options?: LogOptions) => Stream.Stream<StackLogEntry, StackError>;
  readonly activate: (
    capability: CapabilityName,
  ) => Effect.Effect<ActivationResult, GatewayActivationError | StackError>;
  readonly maintenanceHandlers: {
    readonly probe: Effect.Effect<MaintenanceResponse>;
    readonly stop: Effect.Effect<MaintenanceResponse>;
    readonly quiesce: Effect.Effect<MaintenanceResponse>;
  };
  readonly rpcHandlers: StackRpcHandlers;
}

export interface SupervisorOptions {
  readonly identity: StackIdentity;
  readonly stackId: StackId;
  readonly ownerSessionId: string;
  readonly rpcRelease: string;
  readonly stateStore: StackStateStore;
  readonly context: Context.Context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>;
  /** Tests and future catalog composition may provide a concrete runtime. */
  readonly runtime?: SupervisorRuntime;
  readonly runtimeFactory?: SupervisorRuntimeFactory;
}

type ActualPhase = "stopped" | "starting" | "running" | "stopping" | "destroying";

const rpcError = (tag: StackRpcError["tag"], message: string): StackRpcError => ({ tag, message });
const stateErrorMessage = (error: StackError | { readonly message?: string }): string =>
  typeof error.message === "string" ? error.message : "Stack operation failed";

const credentialHost = (address: string): string =>
  address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;

const revealRedacted = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(revealRedacted);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, revealRedacted(entry)]),
  );
};

const digestHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const runtimeUnavailable = (): SupervisorRuntime => {
  const unavailable = (operation: string): Effect.Effect<never, RuntimeDriverError> =>
    Effect.fail(new RuntimeDriverError({ message: `Runtime ${operation} is unavailable` }));
  const driver: RuntimeDriver = {
    observe: () => Effect.succeed([]),
    start: () => unavailable("start"),
    stop: () => unavailable("stop"),
    remove: () => unavailable("remove"),
    cleanup: () => unavailable("cleanup"),
    recover: () => unavailable("recovery"),
  };
  return {
    driver,
    preflight: () =>
      Effect.fail(new StackReconciliationError({ message: "Stack runtime is unavailable" })),
  };
};

const eagerCapabilities = (plan: ExecutionPlan): Set<CapabilityName> => {
  const active = new Set<CapabilityName>();
  const visit = (name: CapabilityName): void => {
    if (active.has(name)) return;
    active.add(name);
    for (const dependency of plan.dependencies[name]) visit(dependency);
  };
  for (const name of CAPABILITY_NAMES) if (plan.activation[name] === "eager") visit(name);
  return active;
};

const activePlan = (plan: ExecutionPlan, active: ReadonlySet<CapabilityName>): ExecutionPlan => ({
  ...plan,
  workloads: plan.workloads.filter((workload) => active.has(workload.capability)),
  startOrder: plan.startOrder.filter((name) => active.has(name)),
  stopOrder: plan.stopOrder.filter((name) => active.has(name)),
});

const capabilityState = (
  name: CapabilityName,
  state: PersistedStackState,
  observed: ReadonlyArray<ObservedWorkload>,
  active: ReadonlySet<CapabilityName>,
  phase: ActualPhase,
  recoveryFailed: boolean,
): CapabilityStatus["state"] => {
  const configured = state.definition?.capabilities[name];
  if (configured === undefined || !configured.enabled) return "disabled";
  if (
    state.desiredLifecycle !== "running" ||
    phase === "stopped" ||
    phase === "stopping" ||
    phase === "destroying"
  )
    return "stopped";
  if (recoveryFailed) return "failed";
  if (configured.activation === "lazy" && !active.has(name)) return "dormant";
  if (phase === "starting") return "starting";
  const resources = observed.filter((entry) => entry.workloadId.startsWith(`${name}:`));
  if (resources.some((entry) => entry.state === "failed")) return "failed";
  if (resources.some((entry) => entry.state === "starting")) return "starting";
  if (resources.length > 0 && resources.every((entry) => entry.state === "ready")) return "ready";
  return "stopped";
};

const statusFor = (
  state: PersistedStackState,
  observed: ReadonlyArray<ObservedWorkload>,
  active: ReadonlySet<CapabilityName>,
  phase: ActualPhase,
  recoveryFailed: boolean,
): Effect.Effect<StackStatus, StackStateInvalidError> =>
  Schema.decodeEffect(StackIdSchema)(state.identity.stackId).pipe(
    Effect.mapError(
      (error) =>
        new StackStateInvalidError({ message: `Invalid persisted StackId: ${String(error)}` }),
    ),
    Effect.map((id) => {
      const definition = state.definition;
      const capabilities = CAPABILITY_NAMES.map((name) => ({
        name,
        activation: definition?.capabilities[name].activation ?? "eager",
        state: capabilityState(name, state, observed, active, phase, recoveryFailed),
      }));
      const versions: Partial<Record<CapabilityName, string>> = {};
      if (definition !== undefined)
        for (const name of CAPABILITY_NAMES) versions[name] = definition.capabilities[name].version;
      const endpoints = state.ports.reduce<
        Readonly<
          Partial<
            Record<
              | "api"
              | "database"
              | "pooler"
              | "studio"
              | "mailUi"
              | "smtp"
              | "pop3"
              | "functionsInspector",
              StackEndpoint
            >
          >
        >
      >((result, assignment) => {
        const tcp =
          assignment.field === "database" ||
          assignment.field === "pooler" ||
          assignment.field === "smtp" ||
          assignment.field === "pop3";
        const protocol = tcp ? "tcp" : "http";
        const listener = state.definition?.listeners[assignment.field];
        return {
          ...result,
          [assignment.field]: {
            protocol,
            address: listener?.address ?? "127.0.0.1",
            port: assignment.port,
            url: `${protocol}://${listener?.address ?? "127.0.0.1"}:${assignment.port}`,
          },
        };
      }, {});
      const activeStates = capabilities.filter(
        ({ name }) => active.has(name) && definition?.capabilities[name].enabled,
      );
      const anyStarting = activeStates.some(({ state }) => state === "starting");
      const anyFailed = activeStates.some(({ state }) => state === "failed");
      const allReady =
        activeStates.length > 0 && activeStates.every(({ state }) => state === "ready");
      const lifecycle =
        state.desiredLifecycle === "unconfigured"
          ? "unconfigured"
          : state.desiredLifecycle === "destroying"
            ? "destroying"
            : state.desiredLifecycle === "stopped"
              ? "stopped"
              : recoveryFailed
                ? "stopped"
                : anyFailed
                  ? "stopped"
                  : phase === "starting"
                    ? "starting"
                    : phase === "stopping"
                      ? "stopping"
                      : phase === "destroying"
                        ? "destroying"
                        : anyStarting
                          ? "starting"
                          : allReady
                            ? "running"
                            : "stopped";
      return {
        id,
        lifecycle,
        desiredLifecycle: state.desiredLifecycle,
        runtime: state.runtime,
        desiredGeneration: state.desiredGeneration,
        endpoints,
        versions,
        capabilities,
      } satisfies StackStatus;
    }),
  );

const mapReconcileError = (error: unknown): StackError => {
  if (error instanceof StackStateInvalidError) return error;
  if (error instanceof RuntimeGenerationMismatchError)
    return new StackLifecycleConflictError({ message: error.message });
  return new StackReconciliationError({
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
};

const rpcTag = (error: StackError, fallback: StackRpcError["tag"]): StackRpcError["tag"] => {
  if (error instanceof InvalidStackIdentityError) return "InvalidStackIdentityError";
  if (error instanceof InvalidProjectRootError) return "InvalidProjectRootError";
  if (error instanceof InvalidStackConfigError) return "InvalidStackConfigError";
  if (error instanceof StackNotFoundError) return "StackNotFoundError";
  if (error instanceof StackOwnershipConflictError) return "StackOwnershipConflictError";
  if (error instanceof StackRuntimeMismatchError) return "StackRuntimeMismatchError";
  if (error instanceof StackDefinitionRequiredError) return "StackDefinitionRequiredError";
  if (error instanceof StackVersionUnsupportedError) return "StackVersionUnsupportedError";
  if (error instanceof StackLifecycleConflictError) return "StackLifecycleConflictError";
  if (error instanceof StackNotRunningError) return "StackNotRunningError";
  if (error instanceof StackMustBeStoppedError) return "StackMustBeStoppedError";
  if (error instanceof StackStateInvalidError) return "StackStateInvalidError";
  if (error instanceof StackStateFormatUnsupportedError) return "StackStateFormatUnsupportedError";
  if (error instanceof StackStateGenerationMismatchError)
    return "StackStateGenerationMismatchError";
  if (error instanceof StackUpgradeRequiredError) return "StackUpgradeRequiredError";
  if (error instanceof StackUpgradeReplacementError) return "StackUpgradeReplacementError";
  if (error instanceof StackSecretMismatchError) return "StackSecretMismatchError";
  if (error instanceof InvalidJwtSigningMaterialError) return "InvalidJwtSigningMaterialError";
  if (error instanceof PortAllocationError) return "PortAllocationError";
  if (error instanceof PortUnavailableError) return "PortUnavailableError";
  if (error instanceof ServiceStartError) return "ServiceStartError";
  if (error instanceof ServiceReadinessError) return "ServiceReadinessError";
  if (error instanceof ContainerEngineError) return "ContainerEngineError";
  if (error instanceof StackReconciliationError) return "StackReconciliationError";
  if (error instanceof StackDestructionError) return "StackDestructionError";
  if (error instanceof GatewayAuthenticationError) return "GatewayAuthenticationError";
  if (error instanceof GatewayStaleGenerationError) return "GatewayStaleGenerationError";
  if (error instanceof GatewayActivationError) return "GatewayActivationError";
  if (error instanceof StackPreparationError) return "StackPreparationError";
  if (error instanceof ArtifactIntegrityError) return "ArtifactIntegrityError";
  if (error instanceof ContainerPullError) return "ContainerPullError";
  return fallback;
};

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
      options.runtime ??
      (options.runtimeFactory === undefined
        ? runtimeUnavailable()
        : yield* options.runtimeFactory.make(initial));
    const reconciler: Reconciler = yield* makeReconciler({
      driver: runtime.driver,
      readGeneration: (stackId) =>
        options.stateStore.read(stackId).pipe(
          Effect.provideContext(options.context),
          Effect.flatMap((state) =>
            state === undefined
              ? Effect.fail(new RuntimeDriverError({ message: "Stack state is missing", stackId }))
              : Effect.succeed(state.desiredGeneration),
          ),
          Effect.mapError((error) =>
            error instanceof RuntimeDriverError
              ? error
              : new RuntimeDriverError({ message: error.message, stackId, cause: error }),
          ),
        ),
    });
    const active = yield* Ref.make<ReadonlySet<CapabilityName>>(new Set());
    const generation = yield* Ref.make(initial.desiredGeneration);
    const phase = yield* Ref.make<ActualPhase>(
      initial.desiredLifecycle === "running" ? "starting" : "stopped",
    );
    const recoveryFailure = yield* Ref.make(false);
    type ActivationHandler = (
      capability: CapabilityName,
    ) => Effect.Effect<ActivationResult, GatewayActivationError | StackError>;
    // The ingress is opened during persisted-running recovery, before the public Supervisor
    // methods are assembled. A one-shot handoff keeps a request waiting for the handler instead of
    // exposing a construction-time race.
    const activationHandler = yield* Deferred.make<ActivationHandler, never>();
    const ingressActivate = (
      capability: CapabilityName,
    ): Effect.Effect<ActivationResult, GatewayActivationError | StackError> =>
      Deferred.await(activationHandler).pipe(Effect.flatMap((handler) => handler(capability)));
    const initializeActivation = (
      plan: ExecutionPlan,
      observed: ReadonlyArray<ObservedWorkload> = [],
    ) => {
      const next = eagerCapabilities(plan);
      for (const entry of observed) {
        const capability = CAPABILITY_NAMES.find((name) => entry.workloadId.startsWith(`${name}:`));
        if (capability !== undefined) next.add(capability);
      }
      return Ref.set(active, next);
    };
    const resetForGeneration = (input: LifecycleInput) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(generation);
        if (current === input.generation && input.desiredLifecycle === "running") return;
        if (input.generation < current)
          return yield* new StackLifecycleConflictError({
            stackId: options.stackId,
            message: "Lifecycle input generation is older than the adopted generation",
          });
        yield* Ref.set(generation, input.generation);
        activationOwned.clear();
        yield* initializeActivation(input.plan);
      });
    const observe = () =>
      runtime.driver.observe(options.stackId).pipe(Effect.mapError(mapReconcileError));
    const observedForStatus = () =>
      Effect.all({ phase: Ref.get(phase), recoveryFailed: Ref.get(recoveryFailure) }).pipe(
        Effect.flatMap(({ phase: current, recoveryFailed }) =>
          current === "running" && !recoveryFailed ? observe() : Effect.succeed([]),
        ),
      );

    const initialStatus = yield* statusFor(
      initial,
      [],
      yield* Ref.get(active),
      yield* Ref.get(phase),
      false,
    );
    const hub = yield* makeStatusHub(initialStatus);
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
          yield* Ref.get(recoveryFailure),
        );
        return status;
      });
    const publish = (): Effect.Effect<StackStatus, StackError> =>
      snapshot().pipe(Effect.tap((value) => hub.publish(value)));
    const restorePhase = (previous: ActualPhase): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const state = yield* read().pipe(Effect.orElseSucceed(() => undefined));
        const next: ActualPhase =
          previous === "running" && state?.desiredLifecycle === "running" ? "running" : "stopped";
        yield* Ref.set(phase, next);
        yield* publish().pipe(Effect.ignore);
      });

    // Admission and execution are separate: callers join the same owned fiber while the
    // execution semaphore serializes lifecycle/activation transitions.
    const admission = yield* Semaphore.make(1);
    const execution = yield* Semaphore.make(1);
    const supervisorScope = yield* Effect.scope;
    const ownedFibers = yield* FiberSet.make().pipe(
      Effect.provideService(Scope.Scope, supervisorScope),
    );
    const joinExit = <A, E>(result: Exit.Exit<A, E>): Effect.Effect<A, E> =>
      Exit.isSuccess(result) ? Effect.succeed(result.value) : Effect.failCause(result.cause);
    type OwnedResult<A, E> = Deferred.Deferred<Exit.Exit<A, E>, never>;
    const startOwned = new Map<string, OwnedResult<StackStatus, StackError>>();
    const restartOwned = new Map<string, OwnedResult<StackStatus, StackError>>();
    const stopOwned = new Map<string, OwnedResult<PersistedStackState, StackError>>();
    const destroyOwned = new Map<string, OwnedResult<void, StackError>>();
    const recoveryOwned = new Map<string, OwnedResult<void, StackError>>();

    const submitOwned = <A, E>(
      slots: Map<string, OwnedResult<A, E>>,
      key: string,
      effect: Effect.Effect<A, E>,
      onWaiterInterrupt?: (owned: OwnedResult<A, E>) => Effect.Effect<void>,
    ): Effect.Effect<A, E> =>
      Effect.gen(function* () {
        const result = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const owned = yield* admission.withPermit(
              Effect.gen(function* () {
                const current = slots.get(key);
                if (current !== undefined) return current;
                const deferred = yield* Deferred.make<Exit.Exit<A, E>, never>();
                slots.set(key, deferred);
                const owner = Effect.gen(function* () {
                  const result = yield* execution.withPermit(effect).pipe(Effect.exit);
                  yield* Deferred.succeed(deferred, result);
                }).pipe(
                  Effect.ensuring(
                    admission.withPermit(
                      Effect.sync(() => {
                        if (slots.get(key) === deferred) slots.delete(key);
                      }),
                    ),
                  ),
                );
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

    const reconcileBackend = (
      input: LifecycleInput,
      selectedOverride?: ReadonlySet<CapabilityName>,
    ): Effect.Effect<void, StackError> =>
      Effect.gen(function* () {
        const reservation =
          input.desiredLifecycle === "running" && runtime.ingress !== undefined
            ? yield* runtime.ingress.acquire(input)
            : undefined;
        if (input.desiredLifecycle !== "running" && runtime.ingress !== undefined)
          yield* runtime.ingress.close;
        yield* resetForGeneration(input);
        const selected = selectedOverride ?? (yield* Ref.get(active));
        const plan =
          input.desiredLifecycle === "running" ? activePlan(input.plan, selected) : input.plan;
        const reconciled = yield* reconciler
          .reconcile({
            stackId: options.stackId,
            desiredGeneration: input.generation,
            desiredLifecycle: input.desiredLifecycle,
            plan,
          })
          .pipe(Effect.mapError(mapReconcileError), Effect.exit);
        if (Exit.isFailure(reconciled)) {
          if (reservation?.fresh === true && runtime.ingress !== undefined)
            yield* runtime.ingress.close.pipe(Effect.ignore);
          return yield* Effect.failCause(reconciled.cause);
        }
        const result = reconciled.value;
        if (result.failed.length > 0)
          return yield* Effect.gen(function* () {
            if (reservation?.fresh === true && runtime.ingress !== undefined)
              yield* runtime.ingress.close.pipe(Effect.ignore);
            return yield* new StackReconciliationError({
              message: result.failed
                .map(({ workloadId, error }) => `${workloadId}: ${error.message}`)
                .join("; "),
            });
          });
        if (runtime.ingress !== undefined && reservation !== undefined) {
          const opened = yield* runtime.ingress
            .open(input, reservation, ingressActivate)
            .pipe(Effect.exit);
          if (Exit.isFailure(opened)) {
            if (reservation.fresh) yield* runtime.ingress.close.pipe(Effect.ignore);
            return yield* Effect.failCause(opened.cause);
          }
        }
        yield* publish();
      });

    const backend: LifecycleBackend = {
      preflight: (input) =>
        runtime.preflight === undefined ? Effect.succeed({}) : runtime.preflight(input),
      reconcile: reconcileBackend,
      cleanup: () =>
        Effect.gen(function* () {
          if (runtime.ingress !== undefined) yield* runtime.ingress.close;
          yield* runtime.driver
            .cleanup({ stackId: options.stackId, destroy: false })
            .pipe(Effect.mapError(mapReconcileError));
          yield* Ref.set(active, new Set());
          yield* Ref.set(phase, "stopped");
          yield* publish();
        }),
      destroyData: () =>
        Effect.gen(function* () {
          if (runtime.ingress !== undefined) yield* runtime.ingress.close;
          yield* runtime.driver
            .cleanup({ stackId: options.stackId, destroy: true })
            .pipe(Effect.mapError(mapReconcileError));
        }),
    };
    const controller = yield* makeLifecycleController({
      stackId: options.stackId,
      runtime: initial.runtime,
      stateStore: options.stateStore,
      backend,
    }).pipe(Effect.provideContext(options.context));
    const status = snapshot();

    const recoveryOperation: Effect.Effect<void, StackError> = Effect.gen(function* () {
      const current = yield* read();
      if (current === undefined)
        return yield* new StackStateInvalidError({ message: "Stack state is missing" });
      // Recovery is deferred until after owner publication. A lifecycle operation may have
      // superseded the construction snapshot while it waited for execution; that operation owns
      // the current phase/generation, so stale recovery must become a no-op.
      if (
        current.desiredGeneration !== initial.desiredGeneration ||
        current.desiredLifecycle !== initial.desiredLifecycle ||
        current.inputFingerprint !== initial.inputFingerprint
      )
        return;
      const definition = current.definition;
      if (definition === undefined || current.desiredLifecycle !== "running") {
        yield* Ref.set(recoveryFailure, false);
        if (options.runtime !== undefined || options.runtimeFactory !== undefined)
          yield* runtime.driver
            .cleanup({ stackId: options.stackId, destroy: false })
            .pipe(Effect.mapError(mapReconcileError));
        yield* Ref.set(active, new Set());
        yield* Ref.set(phase, "stopped");
        yield* publish().pipe(Effect.ignore);
        return;
      }

      yield* Ref.set(phase, "starting");
      yield* Ref.set(recoveryFailure, false);
      yield* publish().pipe(Effect.ignore);
      const attempt = yield* Effect.exit(
        Effect.gen(function* () {
          const plan = yield* rebuildExecutionPlan(current.runtime, definition).pipe(
            Effect.provideContext(options.context),
            Effect.mapError(
              (error) => new StackStateInvalidError({ message: error.message, cause: error }),
            ),
          );
          const request: RuntimeRecoveryRequest = {
            stackId: options.stackId,
            desiredGeneration: current.desiredGeneration,
            desiredLifecycle: "running",
            plan,
          };
          const recoveryInput: LifecycleInput = {
            stackId: options.stackId,
            generation: current.desiredGeneration,
            desiredLifecycle: "running",
            state: current,
            previous: current,
            definition,
            inputFingerprint: current.inputFingerprint ?? "",
            secrets: current.secrets,
            plan,
          };
          yield* initializeActivation(plan);
          const recovered = yield* runtime.driver
            .recover(request)
            .pipe(Effect.mapError(mapReconcileError));
          yield* initializeActivation(plan, recovered);
          yield* reconcileBackend(recoveryInput);
        }),
      );
      if (Exit.isFailure(attempt)) {
        // Recovery must not tear down the owner session. Keep the phase observable as starting
        // and retain the cause in the owner-only log for the next inspection/retry.
        if (runtime.logStore !== undefined)
          yield* runtime.logStore
            .append({
              source: "supervisor",
              stream: "stderr",
              message: `Stack recovery failed: ${Cause.pretty(attempt.cause)}`,
            })
            .pipe(Effect.ignore);
        yield* Ref.set(recoveryFailure, true);
        yield* Ref.set(phase, "starting");
        yield* publish().pipe(Effect.ignore);
        return;
      }
      yield* Ref.set(phase, "running");
      yield* publish().pipe(Effect.ignore);
    }).pipe(Effect.provideContext(options.context));

    const recover = submitOwned(recoveryOwned, "recovery", recoveryOperation).pipe(Effect.ignore);

    const activateOperation = (
      capability: CapabilityName,
    ): Effect.Effect<ActivationResult, GatewayActivationError | StackError> =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        if (state.desiredLifecycle !== "running")
          return yield* new StackNotRunningError({
            message: "Stack must be running before activation",
          });
        if (yield* Ref.get(recoveryFailure))
          return yield* new StackNotRunningError({
            message: "Stack recovery has failed; start or restart the stack before activation",
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
        const next = new Set(yield* Ref.get(active));
        const visit = (name: CapabilityName): void => {
          if (next.has(name)) return;
          next.add(name);
          for (const dependency of plan.dependencies[name]) visit(dependency);
        };
        visit(capability);
        const input: LifecycleInput = {
          stackId: options.stackId,
          generation: state.desiredGeneration,
          desiredLifecycle: "running",
          state,
          previous: state,
          definition,
          inputFingerprint: state.inputFingerprint ?? "",
          secrets: state.secrets,
          plan,
        };
        yield* reconcileBackend(input, next);
        if (runtime.activate === undefined)
          return yield* new GatewayActivationError({
            message: `Capability ${capability} has no route endpoint`,
          });
        const endpoint = yield* runtime.activate(capability, input);
        yield* Ref.set(active, next);
        yield* Ref.set(phase, "running");
        yield* publish();
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
                .withPermit(activateOperation(capability))
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
        yield* Ref.set(phase, "starting");
        yield* publish();
        yield* controller.start({ config: startOptions?.config }).pipe(
          Effect.provideContext(options.context),
          Effect.tapError(() => restorePhase(previous)),
        );
        yield* Ref.set(phase, "running");
        yield* Ref.set(recoveryFailure, false);
        return yield* publish();
      });
    const operationKey = (config: StackConfig | undefined): Effect.Effect<string, StackError> =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        yield* Schema.encodeEffect(StackConfigSchema)(config ?? {}).pipe(
          Effect.mapError(
            (error) =>
              new InvalidStackConfigError({
                stackId: options.stackId,
                message: `Invalid stack configuration: ${String(error)}`,
                cause: error,
              }),
          ),
        );
        const compiled =
          config === undefined &&
          state.definition !== undefined &&
          state.inputFingerprint !== undefined
            ? undefined
            : yield* compileStack({
                projectRoot: state.identity.projectRoot,
                runtime: state.runtime,
                config,
              }).pipe(Effect.provideContext(options.context));
        const fingerprint = compiled?.inputFingerprint ?? state.inputFingerprint;
        if (fingerprint === undefined)
          return yield* new StackStateInvalidError({
            stackId: options.stackId,
            message: "Persisted stack definition fingerprint is missing",
          });
        const secretIdentity: Record<
          string,
          { readonly policy: "managed" | "passthrough"; readonly value?: string }
        > = {};
        if (compiled === undefined) {
          for (const [slot, entry] of Object.entries(state.secrets))
            secretIdentity[slot] = { policy: entry.policy, value: entry.value };
        } else {
          for (const declaration of compiled.secrets) {
            const persisted = state.secrets[declaration.slot];
            const value =
              declaration.value === undefined
                ? persisted?.value
                : String(Redacted.value(declaration.value));
            secretIdentity[declaration.slot] = {
              policy: declaration.policy,
              ...(value === undefined ? {} : { value }),
            };
          }
        }
        const semantics = {
          fingerprint,
          definition: compiled?.definition ?? state.definition,
          secrets: secretIdentity,
        };
        const crypto = yield* Crypto.Crypto;
        const digest = yield* crypto
          .digest("SHA-256", new TextEncoder().encode(canonicalize(revealRedacted(semantics))))
          .pipe(
            Effect.mapError(
              (error) =>
                new InvalidStackConfigError({
                  stackId: options.stackId,
                  message: `Unable to digest stack configuration: ${error.message}`,
                  cause: error,
                }),
            ),
          );
        return digestHex(digest);
      }).pipe(Effect.provideContext(options.context));
    const start = (startOptions?: { readonly config?: StackConfig }) =>
      Effect.gen(function* () {
        const key = yield* operationKey(startOptions?.config);
        return yield* submitOwned(startOwned, key, startOperation(startOptions));
      });
    const restartOperation = (startOptions?: { readonly config?: StackConfig }) =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(phase);
        yield* Ref.set(phase, "starting");
        yield* publish();
        yield* controller.restart({ config: startOptions?.config }).pipe(
          Effect.provideContext(options.context),
          Effect.tapError(() => restorePhase(previous)),
        );
        yield* Ref.set(phase, "running");
        yield* Ref.set(recoveryFailure, false);
        return yield* publish();
      });
    const restart = (startOptions?: { readonly config?: StackConfig }) =>
      Effect.gen(function* () {
        const key = yield* operationKey(startOptions?.config);
        return yield* submitOwned(restartOwned, key, restartOperation(startOptions));
      });
    const stopOperation = () => controller.stop().pipe(Effect.provideContext(options.context));
    const shutdownSignal = yield* Deferred.make<void, never>();
    const signalShutdown = Deferred.succeed(shutdownSignal, undefined).pipe(Effect.asVoid);
    const signalShutdownAfterSuccess = <A, E>(owned: OwnedResult<A, E>) =>
      Deferred.await(owned).pipe(
        Effect.flatMap((result) => (Exit.isSuccess(result) ? signalShutdown : Effect.void)),
      );
    const continueShutdownAfterInterrupt = <A, E>(owned: OwnedResult<A, E>) =>
      FiberSet.run(ownedFibers, signalShutdownAfterSuccess(owned), {
        startImmediately: true,
      }).pipe(Effect.asVoid);
    const stop = submitOwned(stopOwned, "stop", stopOperation());
    // Keep stop and quiesce in separate slots: quiesce's waiter interruption is terminal, while
    // ordinary maintenance stop must never inherit that shutdown continuation.
    const quiesceOwned = new Map<string, OwnedResult<PersistedStackState, StackError>>();
    const quiesce = submitOwned(
      quiesceOwned,
      "quiesce",
      stopOperation(),
      continueShutdownAfterInterrupt,
    );
    const operation = <A>(effect: Effect.Effect<A, StackError>, fallback: StackRpcError["tag"]) =>
      effect.pipe(
        Effect.mapError((error) => rpcError(rpcTag(error, fallback), stateErrorMessage(error))),
      );
    const destroyOperation = controller
      .destroy()
      .pipe(Effect.provideContext(options.context), Effect.andThen(Ref.set(phase, "stopped")));
    const destroy = submitOwned(
      destroyOwned,
      "destroy",
      destroyOperation,
      continueShutdownAfterInterrupt,
    ).pipe(Effect.asVoid);
    const logs = (logOptions?: LogOptions): Stream.Stream<StackLogEntry, StackError> =>
      runtime.logStore === undefined
        ? Stream.fail(new StackNotRunningError({ message: "Stack logs are unavailable" }))
        : runtime.logStore
            .stream(logOptions)
            .pipe(
              Stream.mapError(
                (error) => new StackStateInvalidError({ message: error.message, cause: error }),
              ),
            );
    const watchStatus = hub.changes;
    const maintenanceHandlers = {
      probe: Effect.succeed({
        ok: true,
        op: "probe",
        ownerSessionId: options.ownerSessionId,
        stackId: options.stackId,
        rpcRelease: options.rpcRelease,
      } satisfies MaintenanceResponse),
      stop: stop.pipe(
        Effect.provideContext(options.context),
        Effect.as({ ok: true, op: "stop" } satisfies MaintenanceResponse),
        Effect.orElseSucceed(
          () =>
            ({
              ok: false,
              error: { tag: "operation-failed", message: "Unable to stop stack" },
            }) satisfies MaintenanceResponse,
        ),
      ),
      quiesce: quiesce.pipe(
        Effect.provideContext(options.context),
        Effect.as({ ok: true, op: "quiesce" } satisfies MaintenanceResponse),
        Effect.orElseSucceed(
          () =>
            ({
              ok: false,
              error: { tag: "operation-failed", message: "Unable to quiesce stack" },
            }) satisfies MaintenanceResponse,
        ),
      ),
    };
    const credentials: Effect.Effect<EffectStackCredentials, StackRpcError> = Effect.gen(
      function* () {
        const state = yield* read().pipe(
          Effect.mapError((error) =>
            rpcError(rpcTag(error, "StackStateInvalidError"), stateErrorMessage(error)),
          ),
        );
        const actualPhase = yield* Ref.get(phase);
        const adoptedGeneration = yield* Ref.get(generation);
        if (
          state === undefined ||
          actualPhase !== "running" ||
          state.desiredLifecycle !== "running" ||
          state.portsGeneration !== state.desiredGeneration ||
          adoptedGeneration !== state.desiredGeneration
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
    const prepareOperation = (prepareOptions?: {
      readonly config?: StackConfig;
      readonly capabilities?: ReadonlyArray<CapabilityName>;
    }) =>
      Effect.gen(function* () {
        // Preparation is deliberately based on one fresh state read and never writes it. A
        // supplied config is compiled only to validate/materialize a prospective plan; its secret
        // declarations are intentionally not resolved here.
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });

        let definition: import("../model/Compiler.ts").StackDefinition;
        let plan: ExecutionPlan;
        if (prepareOptions?.config === undefined && state.definition !== undefined) {
          if (state.inputFingerprint === undefined)
            return yield* new StackStateInvalidError({
              stackId: options.stackId,
              message: "Persisted stack definition fingerprint is missing",
            });
          definition = state.definition;
          plan = yield* rebuildExecutionPlan(state.runtime, definition).pipe(
            Effect.provideContext(options.context),
          );
        } else {
          if (
            prepareOptions?.config === undefined &&
            state.desiredLifecycle !== "unconfigured" &&
            state.definition === undefined
          )
            return yield* new StackDefinitionRequiredError({
              stackId: options.stackId,
              message: "A complete stack definition is required",
            });
          const compiled = yield* compileStack({
            projectRoot: state.identity.projectRoot,
            runtime: state.runtime,
            config: prepareOptions?.config,
          }).pipe(Effect.provideContext(options.context));
          definition = compiled.definition;
          plan = compiled.executionPlan;
        }

        const selected = new Set<CapabilityName>();
        const visit = (name: CapabilityName): Effect.Effect<void, StackPreparationError> => {
          if (selected.has(name)) return Effect.void;
          const capability = definition.capabilities[name];
          if (!capability.enabled)
            return Effect.fail(
              new StackPreparationError({
                stackId: options.stackId,
                capability: name,
                message: `Capability ${name} is disabled`,
              }),
            );
          selected.add(name);
          return Effect.forEach(plan.dependencies[name], visit, { discard: true });
        };
        if (prepareOptions?.capabilities === undefined) {
          for (const name of CAPABILITY_NAMES)
            if (definition.capabilities[name].enabled) selected.add(name);
        } else {
          for (const name of new Set(prepareOptions.capabilities)) yield* visit(name);
        }

        const workloads = plan.workloads.filter((workload) => selected.has(workload.capability));
        if (runtime.prepare === undefined)
          return yield* new StackPreparationError({
            stackId: options.stackId,
            message: "Stack runtime artifact preparation is unavailable",
          });
        const artifacts = yield* runtime.prepare(state.runtime, workloads);
        const byCapability = new Map<CapabilityName, ReadonlyArray<PreparedWorkloadArtifact>>();
        for (const artifact of artifacts) {
          const existing = byCapability.get(artifact.capability) ?? [];
          byCapability.set(artifact.capability, [...existing, artifact]);
        }
        const capabilities = plan.startOrder
          .filter((name) => selected.has(name))
          .map((name) => {
            const entries = byCapability.get(name) ?? [];
            const outcome: "cached" | "downloaded" | "pulled" =
              state.runtime.kind === "native"
                ? entries.some((entry) => entry.outcome === "downloaded")
                  ? "downloaded"
                  : "cached"
                : entries.some((entry) => entry.outcome === "pulled")
                  ? "pulled"
                  : "cached";
            return {
              capability: name,
              version: definition.capabilities[name].version,
              outcome,
            };
          });
        return { capabilities };
      }).pipe(Effect.provideContext(options.context));
    const rpcHandlers: StackRpcHandlers = StackRpcGroup.of({
      status: () =>
        status.pipe(
          Effect.mapError((error) => rpcError("StackStateInvalidError", stateErrorMessage(error))),
        ),
      credentials: () => credentials,
      prepare: ({ config, capabilities }) =>
        prepareOperation({ config, capabilities }).pipe(
          Effect.mapError((error) =>
            rpcError(rpcTag(error, "StackPreparationError"), stateErrorMessage(error)),
          ),
        ),
      start: ({ config }: { readonly config?: StackConfig }) =>
        operation(start({ config }), "StackReconciliationError"),
      restart: ({ config }: { readonly config?: StackConfig }) =>
        operation(restart({ config }), "StackReconciliationError"),
      destroy: () => operation(destroy, "StackDestructionError"),
      logs: (logOptions: LogOptions) =>
        logs(logOptions).pipe(
          Stream.mapError((error) =>
            rpcError(rpcTag(error, "StackStateInvalidError"), stateErrorMessage(error)),
          ),
        ),
      watchStatus: () =>
        watchStatus.pipe(
          Stream.mapError((error) => rpcError("StackStateInvalidError", String(error))),
        ),
    });
    return {
      identity: options.identity,
      stackId: options.stackId,
      ownerSessionId: options.ownerSessionId,
      status,
      start,
      restart,
      destroy,
      recover,
      shutdown: Deferred.await(shutdownSignal),
      signalShutdown,
      watchStatus,
      logs,
      activate,
      maintenanceHandlers,
      rpcHandlers,
    } satisfies Supervisor;
  });
