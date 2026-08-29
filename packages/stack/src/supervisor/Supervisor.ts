import {
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Path,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import type { StackIdentity } from "../identity/Identity.ts";
import { rebuildExecutionPlan } from "../model/Compiler.ts";
import type { ExecutionPlan } from "../model/ExecutionPlan.ts";
import {
  CAPABILITY_NAMES,
  type CapabilityName,
  type CapabilityStatus,
} from "../public/Capability.ts";
import type { StackConfig } from "../public/Config.ts";
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

export interface ActivationResult {
  readonly capability: CapabilityName;
  readonly endpoint: { readonly host: string; readonly port: number };
}

/** Runtime construction is injected so catalog/artifact resolution can evolve independently. */
export interface SupervisorRuntime {
  readonly driver: RuntimeDriver;
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
        state: capabilityState(name, state, observed, active, phase),
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
              : phase === "starting"
                ? "starting"
                : phase === "stopping"
                  ? "stopping"
                  : phase === "destroying"
                    ? "destroying"
                    : anyFailed
                      ? "stopped"
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
export const makeSupervisor = (options: SupervisorOptions): Effect.Effect<Supervisor, StackError> =>
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
    const phase = yield* Ref.make<ActualPhase>("stopped");
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
        yield* Ref.set(generation, input.generation);
        yield* initializeActivation(input.plan);
      });
    const observe = () =>
      runtime.driver.observe(options.stackId).pipe(Effect.mapError(mapReconcileError));

    if (initial.definition !== undefined) {
      const plan = yield* rebuildExecutionPlan(initial.runtime, initial.definition).pipe(
        Effect.provideContext(options.context),
        Effect.mapError(
          (error) => new StackStateInvalidError({ message: error.message, cause: error }),
        ),
      );
      if (initial.desiredLifecycle === "running") {
        const request: RuntimeRecoveryRequest = {
          stackId: options.stackId,
          desiredGeneration: initial.desiredGeneration,
          desiredLifecycle: "running",
          plan,
        };
        const recovered = yield* runtime.driver
          .recover(request)
          .pipe(Effect.mapError(mapReconcileError));
        yield* initializeActivation(plan, recovered);
        const recoveryInput: LifecycleInput = {
          stackId: options.stackId,
          generation: initial.desiredGeneration,
          desiredLifecycle: "running",
          state: initial,
          previous: initial,
          definition: initial.definition,
          inputFingerprint: initial.inputFingerprint ?? "",
          secrets: initial.secrets,
          plan,
        };
        const reservation =
          runtime.ingress === undefined ? undefined : yield* runtime.ingress.acquire(recoveryInput);
        const selected = yield* Ref.get(active);
        const reconciliation = yield* reconciler
          .reconcile({
            stackId: options.stackId,
            desiredGeneration: initial.desiredGeneration,
            desiredLifecycle: "running",
            plan: activePlan(plan, selected),
          })
          .pipe(Effect.mapError(mapReconcileError), Effect.exit);
        if (Exit.isFailure(reconciliation)) {
          if (reservation?.fresh === true && runtime.ingress !== undefined)
            yield* runtime.ingress.close.pipe(Effect.ignore);
          return yield* Effect.failCause(reconciliation.cause);
        }
        if (reconciliation.value.failed.length > 0) {
          if (reservation?.fresh === true && runtime.ingress !== undefined)
            yield* runtime.ingress.close.pipe(Effect.ignore);
          return yield* new StackReconciliationError({
            message: reconciliation.value.failed
              .map(({ workloadId, error }) => `${workloadId}: ${error.message}`)
              .join("; "),
          });
        }
        if (runtime.ingress !== undefined && reservation !== undefined) {
          const opened = yield* runtime.ingress
            .open(recoveryInput, reservation, ingressActivate)
            .pipe(Effect.exit);
          if (Exit.isFailure(opened)) {
            if (reservation.fresh) yield* runtime.ingress.close.pipe(Effect.ignore);
            return yield* Effect.failCause(opened.cause);
          }
        }
        yield* Ref.set(phase, "running");
      } else {
        yield* runtime.driver
          .cleanup({ stackId: options.stackId, destroy: false })
          .pipe(Effect.mapError(mapReconcileError));
        yield* Ref.set(active, new Set());
      }
    } else if (options.runtime !== undefined || options.runtimeFactory !== undefined) {
      yield* runtime.driver
        .cleanup({ stackId: options.stackId, destroy: false })
        .pipe(Effect.mapError(mapReconcileError));
    }

    const initialObserved = yield* observe();
    const initialStatus = yield* statusFor(
      initial,
      initialObserved,
      yield* Ref.get(active),
      yield* Ref.get(phase),
    );
    const hub = yield* makeStatusHub(initialStatus);
    const snapshot = (): Effect.Effect<StackStatus, StackError> =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        const status = yield* statusFor(
          state,
          yield* observe(),
          yield* Ref.get(active),
          yield* Ref.get(phase),
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

    const backend: LifecycleBackend = {
      preflight: (input) =>
        runtime.preflight === undefined ? Effect.succeed({}) : runtime.preflight(input),
      reconcile: (input) =>
        Effect.gen(function* () {
          const reservation =
            input.desiredLifecycle === "running" && runtime.ingress !== undefined
              ? yield* runtime.ingress.acquire(input)
              : undefined;
          if (input.desiredLifecycle !== "running" && runtime.ingress !== undefined)
            yield* runtime.ingress.close;
          yield* resetForGeneration(input);
          const selected = yield* Ref.get(active);
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
        }),
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

    const activate = (
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
        yield* Ref.set(active, next);
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
        yield* backend.reconcile(input);
        if (runtime.activate === undefined)
          return yield* new GatewayActivationError({
            message: `Capability ${capability} has no route endpoint`,
          });
        const endpoint = yield* runtime.activate(capability, input);
        yield* Ref.set(phase, "running");
        yield* publish();
        return { capability, endpoint };
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
        return yield* publish();
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
        return yield* publish();
      });
    const operation = <A>(effect: Effect.Effect<A, StackError>, fallback: StackRpcError["tag"]) =>
      effect.pipe(
        Effect.mapError((error) => rpcError(rpcTag(error, fallback), stateErrorMessage(error))),
      );
    const destroy = controller
      .destroy()
      .pipe(Effect.provideContext(options.context), Effect.andThen(Ref.set(phase, "stopped")));
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
      stop: controller.stop().pipe(
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
      quiesce: controller.stop().pipe(
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
        if (
          state === undefined ||
          actualPhase !== "running" ||
          state.desiredLifecycle !== "running" ||
          state.portsGeneration !== state.desiredGeneration
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
      status: () =>
        status.pipe(
          Effect.mapError((error) => rpcError("StackStateInvalidError", stateErrorMessage(error))),
        ),
      credentials: () => credentials,
      prepare: () =>
        Effect.fail(rpcError("StackPreparationError", "Stack preparation is not available yet")),
      start: ({ config }: { readonly config?: StackConfig }) =>
        operation(startOperation({ config }), "StackReconciliationError"),
      restart: ({ config }: { readonly config?: StackConfig }) =>
        operation(restartOperation({ config }), "StackReconciliationError"),
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
      start: startOperation,
      restart: restartOperation,
      destroy,
      watchStatus,
      logs,
      activate,
      maintenanceHandlers,
      rpcHandlers,
    } satisfies Supervisor;
  });
