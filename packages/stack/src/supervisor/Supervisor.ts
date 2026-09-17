import {
  Context,
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Path,
  PlatformError,
  Scope,
  PubSub,
  Ref,
  Schema,
  Stream,
} from "effect";
import { compileServiceInstance, compileServiceRestart, compileStack } from "../model/Compiler.ts";
import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import type { StackRestartPayload } from "../public/Config.ts";
import {
  GatewayActivationError,
  InvalidLogCursorError,
  OwnerRetiringError,
  StackLifecycleConflictError,
  StackCleanupError,
  StackDestructionError,
  StackStateInvalidError,
  ServiceNotFoundError,
  UncertainOperationError,
  isStackError,
  type StackError,
} from "../public/Errors.ts";
import type {
  InstanceArtifactPreparationStatus,
  ServiceStatus,
  StackStatus,
} from "../public/Status.ts";
import type { StackId } from "../public/StackId.ts";
import type { LogQuery, StackLogBatch } from "../public/Logs.ts";
import type {
  AnyEffectServiceConfig,
  PrepareResult,
  SnapshotDescriptor,
} from "../public/Service.ts";
import { EffectCreateServiceOptionsSchema } from "../public/Service.ts";
import type { ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import type { EffectStackCredentials } from "../public/Credentials.ts";
import type { RuntimeDriver } from "../runtime/RuntimeDriver.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { ServiceRestartPayload } from "../public/Service.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import type { InstanceRuntimeInput, LifecycleInput } from "./Lifecycle.ts";
import { selectLogBatch, type LogStore } from "./LogStore.ts";
import type { SupervisorIngress } from "./Ingress.ts";
import {
  STACK_RPC_RELEASE,
  StackRpcGroup,
  type StackRpcError,
  type StackRpcHandlers,
} from "../control/StackRpc.ts";
import {
  PrepareResultSchema,
  ServiceCredentialsSchema,
  ServiceDescriptorListSchema,
  ServiceDescriptorSchema,
  ServiceStatusSchema,
  SnapshotDescriptorSchema,
} from "../control/ServiceProtocol.ts";
import type { MaintenanceResponse } from "../control/MaintenanceProtocol.ts";
import type { ActivationResult } from "../gateway/Gateway.ts";
import type { RuntimeBindingPublication } from "../runtime/RuntimeBinding.ts";
import type { RpcPrefaceLease } from "../control/ControlServer.ts";
import { statusEndpointsFor } from "./StatusEndpoints.ts";
import {
  makeInstanceEngine,
  type InstanceEngine,
  type InstanceRestartCandidate,
  type RestartSharedPatch,
} from "./InstanceEngine.ts";
import { projectServiceCredentials, projectStackCredentials } from "./ServiceCredentials.ts";

/** Runtime construction is injected so catalog/artifact resolution can evolve independently. */
export interface SupervisorRuntime {
  readonly driver: RuntimeDriver;
  readonly preflight: (input: LifecycleInput) => Effect.Effect<void, StackError>;
  /** Prepares one admitted instance and its exact workload closure. */
  readonly prepare: (input: InstanceRuntimeInput) => Effect.Effect<PrepareResult, StackError>;
  /** Legacy whole-stack artifact preparation used by the current stack lifecycle path. */
  readonly prepareArtifacts: (
    input: LifecycleInput,
    selected: ReadonlySet<CapabilityName>,
  ) => Effect.Effect<void, StackError>;
  /** Starts one admitted instance and returns its private backend bindings. */
  readonly start: (
    input: InstanceRuntimeInput,
  ) => Effect.Effect<ReadonlyArray<RuntimeBindingPublication>, StackError>;
  /** Stops one admitted instance while retaining durable data. */
  readonly stop: (input: InstanceRuntimeInput) => Effect.Effect<void, StackError>;
  /** Destroys one admitted instance and its exact owned data/resources. */
  readonly destroy: (input: InstanceRuntimeInput) => Effect.Effect<void, StackError>;
  /** Exports one stopped instance's owned data to a new destination. */
  readonly exportSnapshot: (
    input: InstanceRuntimeInput,
    options: { readonly destination: string },
  ) => Effect.Effect<SnapshotDescriptor, StackError>;
  /** Restores one stopped instance's owned data from a validated source. */
  readonly restoreSnapshot: (
    input: InstanceRuntimeInput,
    options: { readonly source: string },
  ) => Effect.Effect<SnapshotDescriptor, StackError>;
  /** Reads committed snapshot metadata when an owner resumes a completed restore journal. */
  readonly recoverSnapshot?: (
    input: InstanceRuntimeInput,
    operation: import("../model/ServiceRegistry.ts").PersistedPendingOperation,
  ) => Effect.Effect<SnapshotDescriptor | undefined, StackError>;
  /** Best-effort preparation of lazy artifacts after a stack reaches running. */
  readonly prefetch: (state: PersistedStackState) => Effect.Effect<void>;
  /** Current in-memory preparation state; completed cache entries outlive the session. */
  readonly artifacts: Effect.Effect<ReadonlyArray<InstanceArtifactPreparationStatus>>;
  readonly activate: (
    capability: CapabilityName,
    input: LifecycleInput,
  ) => Effect.Effect<ActivationResult["endpoint"], GatewayActivationError | StackError>;
  /** Supervisor-owned public ingress and lazy route activation lifecycle. */
  readonly ingress: SupervisorIngress;
  readonly logStore: LogStore;
}

export interface Supervisor {
  /** Owner-scoped registry and per-instance lifecycle engine. */
  readonly instances: InstanceEngine;
  readonly status: Effect.Effect<StackStatus, StackError>;
  readonly followStatus: Stream.Stream<StackStatus, StackError>;
  readonly start: (options?: {
    readonly services?: ReadonlyArray<ServiceInstanceId>;
  }) => Effect.Effect<StackStatus, StackError>;
  readonly destroy: Effect.Effect<void, StackError>;
  /** Completes after a successful stop or destroy shutdown signal. */
  readonly shutdown: Effect.Effect<void>;
  /** Shuts down only when durable state is absent or cleanly non-running. */
  readonly shutdownIfIdle: Effect.Effect<void>;
  /** Acquires a short-lived witness for an RPC connection before its first request. */
  readonly acquireRpcPreface: Effect.Effect<RpcPrefaceLease, StackError>;
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

const rpcError = (
  tag: StackRpcError["tag"],
  message: string,
  fields?: Partial<
    Pick<
      StackRpcError,
      | "stackId"
      | "instanceId"
      | "ownerSessionId"
      | "operationId"
      | "expectedCreationInputsId"
      | "mutation"
      | "outcome"
    >
  >,
): StackRpcError => ({ tag, message, ...fields });
const stateErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Stack operation failed";

const rpcTag = (error: StackError): StackRpcError["tag"] => error._tag;
const rpcErrorFor = (error: StackError): StackRpcError =>
  rpcError(
    rpcTag(error),
    stateErrorMessage(error),
    error instanceof OwnerRetiringError
      ? { stackId: error.stackId, ownerSessionId: error.ownerSessionId }
      : error instanceof UncertainOperationError
        ? {
            stackId: error.stackId,
            ...(error.instanceId === undefined ? {} : { instanceId: error.instanceId }),
            ...(error.operationId === undefined ? {} : { operationId: error.operationId }),
            ...(error.expectedCreationInputsId === undefined
              ? {}
              : { expectedCreationInputsId: error.expectedCreationInputsId }),
            mutation: error.mutation,
          }
        : error instanceof StackLifecycleConflictError
          ? {
              ...(error.stackId === undefined ? {} : { stackId: error.stackId }),
              ...(error.instanceId === undefined ? {} : { instanceId: error.instanceId }),
              ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
            }
          : error instanceof StackDestructionError && error.outcome !== undefined
            ? { outcome: error.outcome }
            : undefined,
  );
/** Composes one owner process around the registered instance lifecycle engine. */
export const makeSupervisor = (
  options: SupervisorOptions,
): Effect.Effect<Supervisor, StackError, Scope.Scope> =>
  Effect.gen(function* () {
    const read = () =>
      options.stateStore.read(options.stackId).pipe(Effect.provideContext(options.context));
    const initial = yield* read();
    if (initial === undefined)
      return yield* new StackStateInvalidError({ message: "Stack state is missing" });

    const ownerScope = yield* Effect.scope;
    const statusUpdates = yield* PubSub.unbounded<void>();
    type AdmissionMode = "accepting" | "destroying" | "retiring";
    type AdmissionState = {
      readonly mode: AdmissionMode;
      readonly revision: number;
      readonly hasAdmitted: boolean;
      readonly active: number;
      readonly prefaced: number;
      readonly destroyToken?: symbol;
    };
    type AdmissionResult = true | AdmissionMode;
    const admission = yield* Ref.make<AdmissionState>({
      mode: "accepting",
      revision: 0,
      hasAdmitted: false,
      active: 0,
      prefaced: 0,
    });
    const runtime = options.runtime;
    const publishStatus = PubSub.publish(statusUpdates, undefined).pipe(Effect.asVoid);
    const instances = yield* makeInstanceEngine({
      stackId: options.stackId,
      ownerSessionId: options.ownerSessionId,
      stateStore: options.stateStore,
      runtime,
      scope: ownerScope,
      context: options.context,
      publishEndpoints: runtime.ingress.publish,
      unpublishEndpoints: runtime.ingress.unpublish,
      publishStatus,
      armLazyIngress: runtime.ingress.armLazyIngress,
      isInstanceWakeable: runtime.ingress.isInstanceWakeable,
    });
    yield* instances.recover;
    if (runtime.ingress.setInstanceActivator !== undefined)
      yield* runtime.ingress.setInstanceActivator((id) => instances.start(id).pipe(Effect.asVoid));
    if (runtime.ingress.setTrafficAcquirer !== undefined)
      yield* runtime.ingress.setTrafficAcquirer(instances.acquireTraffic);

    const ownerRetiring = () =>
      new OwnerRetiringError({
        stackId: options.stackId,
        ownerSessionId: options.ownerSessionId,
        message: "The stack owner is retiring",
      });
    const admissionFailure = (mode: AdmissionMode): StackError =>
      mode === "retiring"
        ? ownerRetiring()
        : new StackLifecycleConflictError({
            stackId: options.stackId,
            message: "The stack owner is busy destroying",
          });
    const acquireRpcPreface: Effect.Effect<RpcPrefaceLease, StackError> = Effect.uninterruptible(
      Effect.gen(function* () {
        const result = yield* Ref.modify(
          admission,
          (state): readonly [AdmissionResult, AdmissionState] =>
            state.mode === "accepting"
              ? ([
                  true,
                  {
                    ...state,
                    revision: state.revision + 1,
                    prefaced: state.prefaced + 1,
                  },
                ] as const)
              : ([state.mode, state] as const),
        );
        if (result !== true) return yield* admissionFailure(result);
        let released = false;
        return {
          release: Effect.uninterruptible(
            Effect.suspend(() => {
              if (released) return Effect.void;
              released = true;
              return Ref.update(admission, (state) => ({
                ...state,
                revision: state.revision + 1,
                prefaced: Math.max(0, state.prefaced - 1),
              }));
            }),
          ),
        } satisfies RpcPrefaceLease;
      }),
    );
    const admit = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | StackError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* Ref.modify(
            admission,
            (state): readonly [AdmissionResult, AdmissionState] =>
              state.mode === "accepting"
                ? ([
                    true,
                    {
                      ...state,
                      revision: state.revision + 1,
                      hasAdmitted: true,
                      active: state.active + 1,
                    },
                  ] as const)
                : ([state.mode, state] as const),
          );
          if (result !== true) return yield* admissionFailure(result);
          return yield* restore(effect).pipe(
            Effect.ensuring(
              Ref.update(admission, (state) => ({
                ...state,
                revision: state.revision + 1,
                active: Math.max(0, state.active - 1),
              })),
            ),
          );
        }),
      );
    const admitStream = <A, E>(stream: Stream.Stream<A, E>) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const result = yield* Ref.modify(
            admission,
            (state): readonly [AdmissionResult, AdmissionState] =>
              state.mode === "accepting"
                ? ([true, { ...state, revision: state.revision + 1, hasAdmitted: true }] as const)
                : ([state.mode, state] as const),
          );
          if (result !== true) return yield* admissionFailure(result);
          return stream;
        }),
      );
    const serviceStatus = (id: ServiceInstanceId) => instances.status(id);
    const rootEndpoint = statusEndpointsFor;
    const capabilityState = (status: ServiceStatus | undefined) => {
      if (status === undefined || !status.enabled) return "disabled" as const;
      return status.phase === "dormant"
        ? ("dormant" as const)
        : status.phase === "starting"
          ? ("starting" as const)
          : status.phase === "ready"
            ? ("ready" as const)
            : status.phase === "stopping"
              ? ("stopping" as const)
              : status.phase === "failed" || status.phase === "recovery"
                ? ("failed" as const)
                : ("stopped" as const);
    };
    const snapshot = (): Effect.Effect<StackStatus, StackError> =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        const statuses = yield* Effect.forEach(
          state.registry.instances,
          (instance) => serviceStatus(instance.id),
          { concurrency: "unbounded" },
        );
        const byService = new Map<CapabilityName, ServiceStatus>();
        for (const status of statuses) {
          if (state.registry.defaultInstanceIds[status.service] === status.id)
            byService.set(status.service, status);
        }
        const capabilities = CAPABILITY_NAMES.flatMap((name) => {
          const current = byService.get(name);
          if (current === undefined) return [];
          return {
            id: current.id,
            name,
            activation: current.activation,
            state: capabilityState(current),
            ...(current.error === undefined ? {} : { error: current.error.message }),
          };
        });
        const active = statuses.some(
          (status) =>
            status.phase === "ready" ||
            status.phase === "starting" ||
            status.phase === "dormant" ||
            status.phase === "stopping",
        );
        const desired = state.registry.instances.some((instance) => instance.intent === "started")
          ? "running"
          : state.registry.instances.length === 0
            ? "unconfigured"
            : "stopped";
        const lifecycle = active
          ? "running"
          : desired === "unconfigured"
            ? "unconfigured"
            : "stopped";
        const versions: Partial<Record<CapabilityName, string>> = {};
        for (const instance of state.registry.instances)
          if (state.registry.defaultInstanceIds[instance.service] === instance.id)
            versions[instance.service] = instance.config.version;
        return {
          id: options.stackId,
          lifecycle,
          desiredLifecycle: desired,
          runtime: state.runtime,
          endpoints: rootEndpoint(state),
          versions,
          capabilities,
          artifacts: yield* runtime.artifacts,
          instances: statuses,
        } satisfies StackStatus;
      });
    const status = snapshot();
    const followStatus = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(statusUpdates);
        const initialStatus = yield* snapshot();
        return Stream.concat(
          Stream.succeed(initialStatus),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot())),
        );
      }),
    );

    const selected = (ids: ReadonlyArray<ServiceInstanceId> | undefined) =>
      ids === undefined ? instances.startAll() : instances.startAll(ids);
    const start = (input?: { readonly services?: ReadonlyArray<ServiceInstanceId> }) =>
      selected(input?.services).pipe(Effect.andThen(publishStatus), Effect.andThen(snapshot()));
    const sleep = (input?: { readonly services?: ReadonlyArray<ServiceInstanceId> }) =>
      instances
        .sleepAll(input?.services)
        .pipe(Effect.andThen(publishStatus), Effect.andThen(snapshot()));
    const stop = (input?: { readonly services?: ReadonlyArray<ServiceInstanceId> }) =>
      instances
        .stopAll(input?.services)
        .pipe(Effect.andThen(publishStatus), Effect.andThen(snapshot()));
    const restart = (input?: StackRestartPayload): Effect.Effect<StackStatus, StackError> =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });

        if (input === undefined || input.services === undefined) {
          if (input?.config !== undefined) {
            const candidate = yield* compileStack({
              projectRoot: state.identity.projectRoot,
              runtime: state.runtime,
              config: input.config,
              registry: state.registry,
            }).pipe(Effect.provideContext(options.context));
            const endpointIntent = (listener: {
              readonly enabled: boolean;
              readonly address: string;
              readonly port: "automatic" | number;
            }) =>
              listener.enabled
                ? {
                    address: listener.address,
                    port: listener.port === "automatic" ? ("auto" as const) : listener.port,
                  }
                : { enabled: false as const };
            const listeners = input.config.listeners;
            const databaseEndpoint =
              listeners?.database === undefined
                ? undefined
                : endpointIntent(candidate.definition.listeners.database);
            const functionsInspectorEndpoint =
              listeners?.functionsInspector === undefined
                ? undefined
                : endpointIntent(candidate.definition.listeners.functionsInspector);
            const studioEndpoint =
              listeners?.studio === undefined
                ? undefined
                : endpointIntent(candidate.definition.listeners.studio);
            const smtpEndpoint =
              listeners?.smtp === undefined
                ? undefined
                : endpointIntent(candidate.definition.listeners.smtp);
            const pop3Endpoint =
              listeners?.pop3 === undefined
                ? undefined
                : endpointIntent(candidate.definition.listeners.pop3);
            const mailUiEndpoint =
              listeners?.mailUi === undefined
                ? undefined
                : endpointIntent(candidate.definition.listeners.mailUi);
            const poolerEndpoint =
              listeners?.pooler === undefined
                ? undefined
                : endpointIntent(candidate.definition.listeners.pooler);
            const configFor = (service: CapabilityName): AnyEffectServiceConfig => {
              switch (service) {
                case "database":
                  return databaseEndpoint === undefined
                    ? (candidate.sourceConfig.capabilities?.database ?? {})
                    : {
                        ...candidate.sourceConfig.capabilities?.database,
                        endpoints: { sql: databaseEndpoint },
                      };
                case "functions":
                  return functionsInspectorEndpoint === undefined
                    ? (candidate.sourceConfig.capabilities?.functions ?? {})
                    : {
                        ...candidate.sourceConfig.capabilities?.functions,
                        endpoints: { inspector: functionsInspectorEndpoint },
                      };
                case "studio":
                  return studioEndpoint === undefined
                    ? (candidate.sourceConfig.capabilities?.studio ?? {})
                    : {
                        ...candidate.sourceConfig.capabilities?.studio,
                        endpoints: { studio: studioEndpoint },
                      };
                case "mail": {
                  const endpoints = {
                    ...(smtpEndpoint === undefined ? {} : { smtp: smtpEndpoint }),
                    ...(pop3Endpoint === undefined ? {} : { pop3: pop3Endpoint }),
                    ...(mailUiEndpoint === undefined ? {} : { mailUi: mailUiEndpoint }),
                  };
                  return Object.keys(endpoints).length === 0
                    ? (candidate.sourceConfig.capabilities?.mail ?? {})
                    : { ...candidate.sourceConfig.capabilities?.mail, endpoints };
                }
                case "pooler":
                  return poolerEndpoint === undefined
                    ? (candidate.sourceConfig.capabilities?.pooler ?? {})
                    : {
                        ...candidate.sourceConfig.capabilities?.pooler,
                        endpoints: { pooler: poolerEndpoint },
                      };
                case "rest":
                  return candidate.sourceConfig.capabilities?.rest ?? {};
                case "auth":
                  return candidate.sourceConfig.capabilities?.auth ?? {};
                case "realtime":
                  return candidate.sourceConfig.capabilities?.realtime ?? {};
                case "storage":
                  return candidate.sourceConfig.capabilities?.storage ?? {};
                case "analytics":
                  return candidate.sourceConfig.capabilities?.analytics ?? {};
              }
            };
            const candidates: InstanceRestartCandidate[] = [];
            for (const instance of state.registry.instances) {
              if (state.registry.defaultInstanceIds[instance.service] !== instance.id) continue;
              const compiled = yield* compileServiceRestart(instance, configFor(instance.service), {
                projectRoot: state.identity.projectRoot,
                path: Context.get(options.context, Path.Path),
                runtime: state.runtime,
              }).pipe(Effect.provideContext(options.context));
              candidates.push({
                instance: compiled.instance,
                secretSlots: compiled.secretSlots,
                startImmediately:
                  candidate.definition.capabilities[instance.service].enabled &&
                  candidate.definition.capabilities[instance.service].activation === "eager",
                desiredIntent: candidate.definition.capabilities[instance.service].enabled
                  ? "started"
                  : "stopped",
                previous: { state, instance },
              });
            }
            const apiConfigured = input.config.listeners?.api !== undefined;
            const api = candidate.definition.listeners.api;
            const candidateSigning = candidate.definition.security.jwt.signing;
            const security =
              candidateSigning === null
                ? state.security
                : {
                    jwt: {
                      issuer: candidate.definition.security.jwt.issuer,
                      expirySeconds: candidate.definition.security.jwt.expirySeconds,
                      signing: candidateSigning,
                    },
                  };
            const retainedPorts = state.ports.filter(
              (assignment) => assignment.owner !== "stack" || assignment.binding !== "api",
            );
            const ports = !apiConfigured
              ? state.ports
              : api.enabled && typeof api.port === "number"
                ? [
                    ...retainedPorts,
                    {
                      owner: "stack" as const,
                      binding: "api" as const,
                      address: api.address,
                      port: api.port,
                      intent: "exact" as const,
                    },
                  ]
                : retainedPorts;
            const shared: RestartSharedPatch = {
              preparation: candidate.definition.preparation,
              security,
              listeners: !apiConfigured
                ? state.listeners
                : candidate.definition.listeners.api.enabled
                  ? {
                      api: {
                        enabled: true,
                        address: candidate.definition.listeners.api.address,
                        ...(typeof candidate.definition.listeners.api.port === "number"
                          ? { port: candidate.definition.listeners.api.port }
                          : {}),
                      },
                    }
                  : { api: { enabled: false } },
              ports,
              secretSlots: candidate.secrets,
            };
            yield* instances.restartAll(candidates, shared);
          } else {
            yield* instances.stopAll();
          }
          yield* instances.startAll();
        } else {
          const ids = [...new Set(input.services)];
          const updates = input.updates ?? [];
          for (const update of updates) {
            if (!ids.includes(update.id))
              return yield* new StackLifecycleConflictError({
                stackId: options.stackId,
                instanceId: update.id,
                message: "Selected restart update is outside the selected instances",
              });
          }
          if (new Set(updates.map((update) => update.id)).size !== updates.length)
            return yield* new StackLifecycleConflictError({
              stackId: options.stackId,
              message: "Selected restart contains duplicate updates",
            });
          const selected = new Set(ids);
          for (const id of ids) {
            const current = state.registry.instances.find((entry) => entry.id === id);
            if (current === undefined)
              return yield* new ServiceNotFoundError({
                instanceId: id,
                message: `Service instance ${id} was not found`,
              });
            if (current.pendingOperation !== null)
              return yield* new StackLifecycleConflictError({
                stackId: options.stackId,
                instanceId: id,
                message: `Service instance ${id} already has a pending operation`,
              });
            if (
              state.registry.instances.some(
                (dependent) =>
                  dependent.intent === "started" &&
                  !selected.has(dependent.id) &&
                  Object.values(dependent.dependencies).includes(id),
              )
            )
              return yield* new StackLifecycleConflictError({
                stackId: options.stackId,
                instanceId: id,
                message: `Service instance ${id} has active dependents`,
              });
          }
          const updatesById = new Map(updates.map((update) => [update.id, update]));
          const candidates: InstanceRestartCandidate[] = [];
          for (const id of ids) {
            const current = state.registry.instances.find((entry) => entry.id === id);
            if (current === undefined)
              return yield* new ServiceNotFoundError({
                instanceId: id,
                message: `Service instance ${id} was not found`,
              });
            const update = updatesById.get(id);
            if (update === undefined) {
              candidates.push({
                instance: current,
                secretSlots: [],
                previous: { state, instance: current },
              });
              continue;
            }
            if (current.service !== update.service)
              return yield* new StackLifecycleConflictError({
                stackId: options.stackId,
                instanceId: id,
                message: `Restart service kind ${update.service} does not match registered ${current.service}`,
              });
            if (update.config === undefined)
              return yield* new StackLifecycleConflictError({
                stackId: options.stackId,
                instanceId: id,
                message: "Selected restart update requires service configuration",
              });
            const compiled = yield* compileServiceRestart(current, update.config, {
              projectRoot: state.identity.projectRoot,
              path: Context.get(options.context, Path.Path),
              runtime: state.runtime,
            }).pipe(Effect.provideContext(options.context));
            candidates.push({
              instance: compiled.instance,
              secretSlots: compiled.secretSlots,
              previous: { state, instance: current },
            });
          }
          yield* instances.restartAll(candidates);
        }
        yield* publishStatus;
        return yield* snapshot();
      }).pipe(
        Effect.provideContext(options.context),
        Effect.mapError((error) =>
          isStackError(error)
            ? error
            : new StackStateInvalidError({
                stackId: options.stackId,
                message: `Invalid restart request: ${String(error)}`,
                cause: error,
              }),
        ),
      );
    const destroy = (
      services?: ReadonlyArray<ServiceInstanceId>,
    ): Effect.Effect<void, StackError> =>
      Effect.suspend(() => {
        const destroyToken = Symbol("destroy-operation");
        return Effect.uninterruptible(
          Effect.gen(function* () {
            if (services === undefined) {
              const result = yield* Ref.modify(
                admission,
                (state): readonly [AdmissionResult, AdmissionState] =>
                  state.mode === "accepting" && state.active === 0
                    ? ([
                        true,
                        {
                          ...state,
                          mode: "destroying" as const,
                          destroyToken,
                          hasAdmitted: true,
                          revision: state.revision + 1,
                        },
                      ] as const)
                    : ([state.mode, state] as const),
              );
              if (result !== true) return yield* admissionFailure(result);
            }
            yield* instances.destroyAll(services);
            if (services === undefined)
              yield* runtime.driver.cleanup({ stackId: options.stackId, destroy: true }).pipe(
                Effect.mapError(
                  (error) =>
                    new StackCleanupError({
                      message: "Unable to clean up stack runtime resources",
                      cause: error,
                    }),
                ),
              );
            if (services === undefined)
              yield* options.stateStore
                .cleanup(options.stackId)
                .pipe(Effect.provideContext(options.context));
            if (services === undefined)
              yield* Ref.update(admission, (state) =>
                state.mode === "destroying" && state.destroyToken === destroyToken
                  ? {
                      ...state,
                      mode: "retiring" as const,
                      destroyToken: undefined,
                      revision: state.revision + 1,
                    }
                  : state,
              );
            yield* publishStatus;
          }).pipe(
            Effect.tapError((error) =>
              !(error instanceof StackCleanupError || error instanceof UncertainOperationError)
                ? Ref.update(admission, (state) =>
                    state.mode === "destroying" && state.destroyToken === destroyToken
                      ? {
                          ...state,
                          mode: "accepting" as const,
                          destroyToken: undefined,
                          revision: state.revision + 1,
                        }
                      : state,
                  )
                : Effect.void,
            ),
          ),
        );
      });
    const logs = (query?: LogQuery) =>
      runtime.logStore
        .read(query?.cursor === undefined ? undefined : { cursor: query.cursor })
        .pipe(
          Effect.mapError((error) =>
            error instanceof InvalidLogCursorError
              ? error
              : new StackStateInvalidError({ message: error.message, cause: error }),
          ),
          Effect.map((scanned) => ({ ...selectLogBatch(scanned, query), running: true })),
        );

    const credentials: Effect.Effect<EffectStackCredentials, StackError> = read().pipe(
      Effect.flatMap((state) =>
        state === undefined
          ? Effect.fail(new StackStateInvalidError({ message: "Stack state is missing" }))
          : projectStackCredentials(state),
      ),
    );

    const activate: Supervisor["activate"] = (capability) =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        const id = state.registry.defaultInstanceIds[capability];
        if (id === undefined)
          return yield* new GatewayActivationError({
            message: `Capability ${capability} is not enabled`,
          });
        const current = yield* instances.start(id);
        const endpoint = current.endpoints.find((entry) => entry.availability === "listening");
        if (endpoint === undefined)
          return yield* new GatewayActivationError({
            message: `Service ${id} has no listening endpoint`,
          });
        return {
          capability,
          instanceId: id,
          endpoint: { host: endpoint.address, port: endpoint.port },
        };
      });

    const toRpc = <A, E = unknown, R = never>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, StackRpcError, R> =>
      effect.pipe(
        Effect.mapError((error) =>
          rpcErrorFor(
            isStackError(error)
              ? error
              : new StackStateInvalidError({
                  stackId: options.stackId,
                  message: error instanceof Error ? error.message : String(error),
                  cause: error,
                }),
          ),
        ),
      );
    const decodeRpc = <S extends Schema.Constraint>(
      schema: S,
      effect: Effect.Effect<unknown, StackError | PlatformError.PlatformError, never>,
    ): Effect.Effect<S["Type"], StackRpcError, S["DecodingServices"]> => {
      return effect.pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(schema)(value).pipe(
            Effect.mapError(
              (error) =>
                new StackStateInvalidError({
                  stackId: options.stackId,
                  message: `Invalid RPC result: ${String(error)}`,
                  cause: error,
                }),
            ),
          ),
        ),
        Effect.mapError((error) =>
          rpcErrorFor(
            isStackError(error)
              ? error
              : new StackStateInvalidError({
                  stackId: options.stackId,
                  message: `Invalid RPC result: ${String(error)}`,
                  cause: error,
                }),
          ),
        ),
      );
    };
    const servicesCreate = (payload: unknown) =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        const input = yield* Schema.decodeUnknownEffect(EffectCreateServiceOptionsSchema)(
          payload,
        ).pipe(
          Effect.mapError(
            (error) =>
              new StackStateInvalidError({
                message: "Invalid service creation request",
                cause: error,
              }),
          ),
        );
        const compiled = yield* compileServiceInstance(input, {
          projectRoot: state.identity.projectRoot,
          path: Context.get(options.context, Path.Path),
          registry: state.registry,
          runtime: state.runtime,
        }).pipe(Effect.provideContext(options.context));
        return yield* instances.create(compiled.instance, compiled.secretSlots);
      }).pipe(Effect.provideContext(options.context));
    const serviceRestart = (payload: ServiceRestartPayload) =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        const current = state.registry.instances.find((entry) => entry.id === payload.id);
        if (current === undefined)
          return yield* new StackStateInvalidError({
            message: `Service instance ${payload.id} was not found`,
          });
        if (payload.config === undefined) return yield* instances.restart(payload.id);
        const compiled = yield* compileServiceRestart(current, payload.config, {
          projectRoot: state.identity.projectRoot,
          path: Context.get(options.context, Path.Path),
          runtime: state.runtime,
        }).pipe(Effect.provideContext(options.context));
        const candidate: InstanceRestartCandidate = {
          instance: compiled.instance,
          secretSlots: compiled.secretSlots,
          previous: { state, instance: current },
        };
        return yield* instances.restart(payload.id, candidate);
      }).pipe(Effect.provideContext(options.context));
    const serviceCredentials = ({ id }: { readonly id: ServiceInstanceId }) =>
      Effect.gen(function* () {
        const state = yield* read();
        if (state === undefined)
          return yield* new StackStateInvalidError({ message: "Stack state is missing" });
        const instance = state.registry.instances.find((entry) => entry.id === id);
        if (instance === undefined)
          return yield* new ServiceNotFoundError({
            instanceId: id,
            message: `Service instance ${id} was not found`,
          });
        switch (instance.service) {
          case "database":
            return yield* projectServiceCredentials(state, instance);
          case "functions":
            return yield* projectServiceCredentials(state, instance);
          case "storage":
            return yield* projectServiceCredentials(state, instance);
          default:
            return { kind: "none" as const };
        }
      }).pipe(Effect.provideContext(options.context));
    const rpcHandlers: StackRpcHandlers = StackRpcGroup.of({
      servicesCreate: (payload) =>
        decodeRpc(ServiceDescriptorSchema, admit(servicesCreate(payload))),
      servicesGet: (payload) =>
        decodeRpc(ServiceDescriptorSchema, admit(instances.describe(payload))),
      servicesList: () => decodeRpc(ServiceDescriptorListSchema, admit(instances.list)),
      serviceStatus: ({ id }) => decodeRpc(ServiceStatusSchema, admit(serviceStatus(id))),
      serviceFollowStatus: ({ id }) =>
        admitStream(instances.followStatus(id)).pipe(Stream.mapError(rpcErrorFor)),
      serviceStart: ({ id }) => decodeRpc(ServiceStatusSchema, admit(instances.start(id))),
      serviceSleep: ({ id }) => decodeRpc(ServiceStatusSchema, admit(instances.sleep(id))),
      serviceStop: ({ id }) => decodeRpc(ServiceStatusSchema, admit(instances.stop(id))),
      serviceDestroy: ({ id }) => toRpc(admit(instances.destroy(id))),
      servicePrepare: ({ id }) => decodeRpc(PrepareResultSchema, admit(instances.prepare(id))),
      serviceRestart: (payload) => decodeRpc(ServiceStatusSchema, admit(serviceRestart(payload))),
      serviceCredentials: (payload) =>
        decodeRpc(ServiceCredentialsSchema, admit(serviceCredentials(payload))),
      serviceLogs: ({ id, query }) => toRpc(admit(logs({ ...query, services: [id] }))),
      serviceExportSnapshot: ({ id, destination }) =>
        decodeRpc(SnapshotDescriptorSchema, admit(instances.exportSnapshot(id, destination))),
      serviceRestoreSnapshot: ({ id, source }) =>
        decodeRpc(SnapshotDescriptorSchema, admit(instances.restoreSnapshot(id, source))),
      status: () => toRpc(admit(status)),
      followStatus: () => admitStream(followStatus).pipe(Stream.mapError(rpcErrorFor)),
      credentials: () => toRpc(admit(credentials)),
      start: (payload) => toRpc(admit(start(payload))),
      sleep: (payload) => toRpc(admit(sleep(payload))),
      stop: (payload) => toRpc(admit(stop(payload))),
      restart: (payload) => toRpc(admit(restart(payload))),
      destroy: ({ services }) =>
        toRpc(services === undefined ? destroy() : admit(destroy(services))),
      logs: (query) => toRpc(admit(logs(query))),
    });
    const shutdownSignal = yield* Deferred.make<void, never>();
    const shutdownIfIdle = Effect.gen(function* () {
      const before = yield* Ref.get(admission);
      if (
        before.active > 0 ||
        before.prefaced > 0 ||
        !before.hasAdmitted ||
        before.mode === "destroying"
      )
        return;
      const state = yield* read();
      const clean =
        state === undefined ||
        state.registry.instances.every(
          (instance) => instance.intent === "stopped" && instance.pendingOperation === null,
        );
      if (!clean) return;
      const retired = yield* Ref.modify(admission, (current) =>
        current.revision === before.revision &&
        current.hasAdmitted &&
        current.active === 0 &&
        current.prefaced === 0 &&
        (current.mode === "accepting" || current.mode === "retiring")
          ? ([
              true,
              { ...current, mode: "retiring" as const, revision: current.revision + 1 },
            ] as const)
          : ([false, current] as const),
      );
      if (retired) {
        yield* Deferred.succeed(shutdownSignal, undefined);
      }
    }).pipe(Effect.ignoreCause);
    const stopWithShutdown = Effect.suspend(() => {
      return admit(stop());
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
        Effect.as({ ok: true, op: "stop" } satisfies MaintenanceResponse),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false,
            error: { tag: "operation-failed", message: stateErrorMessage(error) },
          } satisfies MaintenanceResponse),
        ),
      ),
    };
    return {
      instances,
      status,
      followStatus,
      start,
      destroy: destroy(),
      shutdown: Deferred.await(shutdownSignal),
      shutdownIfIdle,
      acquireRpcPreface,
      logs,
      activate,
      maintenanceHandlers,
      rpcHandlers,
    } satisfies Supervisor;
  });
