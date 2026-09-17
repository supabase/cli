import {
  Cause,
  Crypto,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Path,
  PubSub,
  Option,
  Ref,
  Scope,
  Semaphore,
  Schema,
  Stream,
  Redacted,
} from "effect";
import {
  createExecutionPlan,
  activeExecutionPlan,
  dependencyClosure,
  type ExecutionPlan,
} from "../model/ExecutionPlan.ts";
import {
  AnalyticsSettingsSchema,
  AuthSettingsSchema,
  DatabaseSettingsSchema,
  FunctionsSettingsSchema,
  MailSettingsSchema,
  PoolerSettingsSchema,
  RealtimeSettingsSchema,
  RestSettingsSchema,
  StorageSettingsSchema,
  StudioSettingsSchema,
} from "../model/capabilities/index.ts";
import {
  registerServiceInstance,
  removeServiceInstance,
  type PersistedServiceInstance,
  type PersistedServiceInstanceFor,
  type PersistedServiceRegistry,
  type PersistedPendingOperation,
  PersistedServiceInstanceSchema,
} from "../model/ServiceRegistry.ts";
import type { ServiceInstanceId } from "../public/ServiceInstanceId.ts";
import type {
  AnyServiceDescriptor,
  RedactedServiceSettings,
  ServiceDescriptor,
  ServiceKind,
  PrepareResult,
  SnapshotDescriptor,
} from "../public/Service.ts";
import {
  PORT_FIELD_PROTOCOL,
  type ServiceFailure,
  type ServiceStatus,
  type StackRecovery,
} from "../public/Status.ts";
import {
  ServiceNotFoundError,
  StackLifecycleConflictError,
  StackDestructionError,
  StackCleanupError,
  StackStateInvalidError,
  UnsupportedSnapshotError,
  UncertainOperationError,
  isStackError,
  type LifecycleOutcome,
  type StackError,
} from "../public/Errors.ts";
import type { StackId } from "../public/StackId.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { redactKnownSecrets, resolveSecrets } from "../state/SecretStore.ts";
import type { InstanceRuntimeInput } from "./Lifecycle.ts";
import type { SupervisorRuntime } from "./Supervisor.ts";
import {
  fingerprintBootstrapInputs,
  fingerprintEffectiveConfig,
  type SecretSlotInput,
} from "../model/Compiler.ts";
import type { RuntimeBindingPublication } from "../runtime/RuntimeBinding.ts";
import { privateBindingIntentsFor } from "../runtime/WorkloadRuntimeSpec.ts";
import { makeIdleRetirement } from "./IdleRetirement.ts";
import type { TrafficAdmissionMode, TrafficLease } from "./Ingress.ts";
import { portFieldForInstanceBinding } from "./StatusEndpoints.ts";

type Mutation =
  | "start"
  | "sleep"
  | "stop"
  | "destroy"
  | "restart"
  | "exportSnapshot"
  | "restoreSnapshot";

type Phase = ServiceStatus["phase"];
type StatusUpdate =
  | { readonly id: ServiceInstanceId; readonly destroyed: false }
  | { readonly id: ServiceInstanceId; readonly destroyed: true };

const protocolForInstanceBinding = (binding: string): "http" | "tcp" => {
  const field = portFieldForInstanceBinding(binding);
  return field === undefined ? "http" : PORT_FIELD_PROTOCOL[field];
};

function redactSettings<K extends ServiceKind>(
  value: PersistedServiceInstanceFor<K>["config"]["settings"],
): RedactedServiceSettings<K>;
function redactSettings(current: unknown): unknown {
  if (current === null) return undefined;
  if (Array.isArray(current))
    return current.map(redactSettings).filter((item) => item !== undefined);
  if (typeof current === "object") {
    if (
      current !== null &&
      Object.hasOwn(current, "slot") &&
      typeof Reflect.get(current, "slot") === "string" &&
      Object.keys(current).length === 1
    )
      return { redacted: true };
    return Object.fromEntries(
      Object.entries(current).flatMap(([key, item]) => {
        const projected = redactSettings(item);
        return projected === undefined ? [] : [[key, projected]];
      }),
    );
  }
  return current;
}

const restoreSecretSlots = (current: unknown): unknown => {
  if (current === null) return undefined;
  if (Array.isArray(current))
    return current.map(restoreSecretSlots).filter((item) => item !== undefined);
  if (typeof current === "object") {
    if (
      current !== null &&
      Object.hasOwn(current, "slot") &&
      typeof Reflect.get(current, "slot") === "string" &&
      Object.keys(current).length === 1
    )
      return Redacted.make("");
    return Object.fromEntries(
      Object.entries(current).flatMap(([key, item]) => {
        const restored = restoreSecretSlots(item);
        return restored === undefined ? [] : [[key, restored]];
      }),
    );
  }
  return current;
};

const validateSettings = (
  service: ServiceKind,
  value: unknown,
): Effect.Effect<void, Schema.SchemaError> => {
  const options = { onExcessProperty: "error" as const };
  switch (service) {
    case "database":
      return Schema.decodeUnknownEffect(DatabaseSettingsSchema, options)(value).pipe(Effect.asVoid);
    case "rest":
      return Schema.decodeUnknownEffect(RestSettingsSchema, options)(value).pipe(Effect.asVoid);
    case "auth":
      return Schema.decodeUnknownEffect(AuthSettingsSchema, options)(value).pipe(Effect.asVoid);
    case "realtime":
      return Schema.decodeUnknownEffect(RealtimeSettingsSchema, options)(value).pipe(Effect.asVoid);
    case "storage":
      return Schema.decodeUnknownEffect(StorageSettingsSchema, options)(value).pipe(Effect.asVoid);
    case "functions":
      return Schema.decodeUnknownEffect(
        FunctionsSettingsSchema,
        options,
      )(value).pipe(Effect.asVoid);
    case "studio":
      return Schema.decodeUnknownEffect(StudioSettingsSchema, options)(value).pipe(Effect.asVoid);
    case "mail":
      return Schema.decodeUnknownEffect(MailSettingsSchema, options)(value).pipe(Effect.asVoid);
    case "analytics":
      return Schema.decodeUnknownEffect(
        AnalyticsSettingsSchema,
        options,
      )(value).pipe(Effect.asVoid);
    case "pooler":
      return Schema.decodeUnknownEffect(PoolerSettingsSchema, options)(value).pipe(Effect.asVoid);
  }
};

const projectSettings = <K extends ServiceKind>(
  stackId: StackId,
  service: K,
  value: PersistedServiceInstanceFor<K>["config"]["settings"],
): Effect.Effect<RedactedServiceSettings<K>, StackStateInvalidError> =>
  validateSettings(service, restoreSecretSlots(value)).pipe(
    Effect.mapError(
      (error) =>
        new StackStateInvalidError({
          stackId,
          message: `Invalid persisted settings for service ${service}`,
          cause: error,
        }),
    ),
    Effect.map(() => redactSettings<K>(value)),
  );

export interface InstanceEngineOptions {
  readonly stackId: StackId;
  readonly ownerSessionId: string;
  readonly stateStore: StackStateStore;
  readonly runtime: Pick<
    SupervisorRuntime,
    | "start"
    | "stop"
    | "destroy"
    | "prepare"
    | "exportSnapshot"
    | "restoreSnapshot"
    | "recoverSnapshot"
  >;
  readonly scope: Scope.Scope;
  readonly context: import("effect").Context.Context<
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >;
  readonly publishEndpoints?: (
    instanceId: ServiceInstanceId,
    publications: ReadonlyArray<RuntimeBindingPublication>,
  ) => Effect.Effect<void, StackError>;
  readonly unpublishEndpoints?: (
    instanceId: ServiceInstanceId,
    preserveListener?: boolean,
  ) => Effect.Effect<void, StackError>;
  /** Notifies the owner-level status stream after a durable instance transition. */
  readonly publishStatus?: Effect.Effect<void>;
  /** Arms shared lazy ingress after the durable started intent is committed. */
  readonly armLazyIngress?: (
    state: PersistedStackState,
    plan: ExecutionPlan,
  ) => Effect.Effect<void, StackError>;
  readonly isInstanceActive?: (instanceId: ServiceInstanceId) => Effect.Effect<boolean>;
  readonly isInstanceWakeable?: (instanceId: ServiceInstanceId) => Effect.Effect<boolean>;
}

/** A compiled replacement plus the exact generation that was used to compile it. */
export interface InstanceRestartCandidate {
  readonly instance: PersistedServiceInstance;
  readonly secretSlots: ReadonlyArray<SecretSlotInput>;
  /** Whole-stack restart uses this to preserve lazy and disabled activation policy. */
  readonly startImmediately?: boolean;
  readonly desiredIntent?: "started" | "stopped";
  readonly previous: Readonly<{
    readonly state: PersistedStackState;
    readonly instance: PersistedServiceInstance;
  }>;
  readonly admission?: Readonly<{ readonly operationId: string; readonly generation: number }>;
}

/** Shared stack material committed with a whole restart admission. */
export interface RestartSharedPatch {
  readonly preparation?: PersistedStackState["preparation"];
  readonly security?: PersistedStackState["security"];
  readonly listeners?: PersistedStackState["listeners"];
  readonly ports?: PersistedStackState["ports"];
  readonly secretSlots?: ReadonlyArray<SecretSlotInput>;
}

export interface InstanceEngine {
  readonly create: (
    instance: PersistedServiceInstance,
    secretSlots?: ReadonlyArray<SecretSlotInput>,
  ) => Effect.Effect<AnyServiceDescriptor, StackError>;
  readonly get: (
    ref: { readonly id: ServiceInstanceId } | { readonly name: string },
  ) => Effect.Effect<PersistedServiceInstance, ServiceNotFoundError | StackError>;
  readonly describe: (
    ref: { readonly id: ServiceInstanceId } | { readonly name: string },
  ) => Effect.Effect<AnyServiceDescriptor, ServiceNotFoundError | StackError>;
  readonly list: Effect.Effect<ReadonlyArray<AnyServiceDescriptor>, StackError>;
  readonly status: (
    id: ServiceInstanceId,
  ) => Effect.Effect<ServiceStatus, ServiceNotFoundError | StackError>;
  readonly followStatus: (
    id: ServiceInstanceId,
  ) => Stream.Stream<ServiceStatus, ServiceNotFoundError | StackError>;
  readonly start: (
    id: ServiceInstanceId,
  ) => Effect.Effect<ServiceStatus, ServiceNotFoundError | StackError>;
  /** Atomically admits gateway traffic for one instance and returns its release lease. */
  readonly acquireTraffic: (
    id: ServiceInstanceId,
    mode?: TrafficAdmissionMode,
  ) => Effect.Effect<TrafficLease, ServiceNotFoundError | StackError>;
  /** Applies one lifecycle operation to every selected registered instance. */
  readonly startAll: (
    ids?: ReadonlyArray<ServiceInstanceId>,
  ) => Effect.Effect<ReadonlyArray<ServiceStatus>, ServiceNotFoundError | StackError>;
  readonly sleepAll: (
    ids?: ReadonlyArray<ServiceInstanceId>,
  ) => Effect.Effect<ReadonlyArray<ServiceStatus>, ServiceNotFoundError | StackError>;
  readonly stopAll: (
    ids?: ReadonlyArray<ServiceInstanceId>,
  ) => Effect.Effect<ReadonlyArray<ServiceStatus>, ServiceNotFoundError | StackError>;
  readonly stop: (
    id: ServiceInstanceId,
  ) => Effect.Effect<ServiceStatus, ServiceNotFoundError | StackError>;
  readonly sleep: (
    id: ServiceInstanceId,
  ) => Effect.Effect<ServiceStatus, ServiceNotFoundError | StackError>;
  readonly destroy: (
    id: ServiceInstanceId,
  ) => Effect.Effect<void, ServiceNotFoundError | StackError>;
  readonly destroyAll: (
    ids?: ReadonlyArray<ServiceInstanceId>,
  ) => Effect.Effect<void, ServiceNotFoundError | StackError>;
  readonly prepare: (
    id: ServiceInstanceId,
  ) => Effect.Effect<PrepareResult, ServiceNotFoundError | StackError>;
  readonly restart: (
    id: ServiceInstanceId,
    candidate?: InstanceRestartCandidate,
  ) => Effect.Effect<ServiceStatus, ServiceNotFoundError | StackError>;
  readonly restartAll: (
    candidates: ReadonlyArray<InstanceRestartCandidate>,
    shared?: RestartSharedPatch,
  ) => Effect.Effect<ReadonlyArray<ServiceStatus>, ServiceNotFoundError | StackError>;
  readonly exportSnapshot: (
    id: ServiceInstanceId,
    destination: string,
  ) => Effect.Effect<
    import("../public/Service.ts").SnapshotDescriptor,
    ServiceNotFoundError | StackError
  >;
  readonly restoreSnapshot: (
    id: ServiceInstanceId,
    source: string,
  ) => Effect.Effect<
    import("../public/Service.ts").SnapshotDescriptor,
    ServiceNotFoundError | StackError
  >;
  /** Reads committed snapshot evidence after an owner crash before clearing its journal. */
  readonly recoverSnapshot?: (
    input: InstanceRuntimeInput,
    operation: PersistedPendingOperation,
  ) => Effect.Effect<SnapshotDescriptor | undefined, StackError>;
  /** Proves cleanup for operations left fenced by an interrupted owner. */
  readonly recover: Effect.Effect<void, StackError>;
}

const notFound = (id: ServiceInstanceId): ServiceNotFoundError =>
  new ServiceNotFoundError({ instanceId: id, message: `Service instance ${id} was not found` });

const joinExit = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> =>
  Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause);

const errorFromCause = (cause: Cause.Cause<StackError>): StackError => {
  const value = Cause.squash(cause);
  return isStackError(value)
    ? value
    : new StackStateInvalidError({ message: String(value), cause: value });
};

const serviceFailureFor = (
  id: ServiceInstanceId,
  operationId: string,
  state: PersistedStackState,
  error: StackError,
): ServiceFailure => ({
  tag: error._tag,
  message: redactKnownSecrets(
    error.message,
    Object.values(state.secrets).map(({ value }) => value),
  ),
  instanceId: id,
  operationId,
});

const outcomeFor = (
  requested: ReadonlyArray<ServiceInstanceId>,
  affected: ReadonlyArray<ServiceInstanceId>,
  completed: ReadonlyArray<boolean>,
): LifecycleOutcome => ({
  requested,
  affected,
  succeeded: affected.filter((_, index) => completed[index] === true),
  failed: affected.filter((_, index) => completed[index] !== true),
});

const voidExit = <E>(exit: Exit.Exit<unknown, E>): Exit.Exit<void, E> =>
  Exit.isSuccess(exit) ? Exit.succeed(undefined) : Exit.failCause(exit.cause);

const findInstance = (
  registry: PersistedServiceRegistry,
  ref: { readonly id: ServiceInstanceId } | { readonly name: string },
): PersistedServiceInstance | undefined =>
  "id" in ref
    ? registry.instances.find((instance) => instance.id === ref.id)
    : registry.instances.find((instance) => instance.name === ref.name);

const descriptorForKind = <K extends ServiceKind>(
  stackId: StackId,
  state: PersistedStackState,
  instance: PersistedServiceInstanceFor<K>,
): Effect.Effect<ServiceDescriptor<K>, StackStateInvalidError> =>
  Effect.gen(function* () {
    const inputs = instance.initializationInputs;
    const initializationServices = ["auth", "storage", "realtime", "analytics", "pooler"] as const;
    const initialization =
      inputs === null
        ? undefined
        : {
            profileId: inputs.profileId,
            recipes: initializationServices.flatMap((service) => {
              const recipe = inputs.catalog[service];
              if (recipe === undefined) return [];
              const recipeId = `${service}:${recipe.version}`;
              const receipt = instance.initialization?.recipes.find(
                (entry) => entry.recipeId === recipeId,
              );
              return [
                {
                  service,
                  recipeId,
                  artifactIdentity: receipt?.artifactIdentity ?? `${service}@${recipe.version}`,
                  completed: receipt?.completed ?? false,
                },
              ];
            }),
          };
    const endpoints = Object.fromEntries(
      state.ports
        .filter(
          (assignment) => assignment.owner === "instance" && assignment.instanceId === instance.id,
        )
        .map((assignment) => {
          const protocol = protocolForInstanceBinding(assignment.binding);
          return [
            assignment.binding,
            {
              address: assignment.address,
              port: assignment.port,
              url: `${protocol}://${assignment.address}:${assignment.port}`,
              protocol,
            },
          ];
        }),
    );
    return {
      id: instance.id,
      service: instance.service,
      ...(instance.name === undefined ? {} : { name: instance.name }),
      enabled: instance.config.enabled,
      config: {
        enabled: instance.config.enabled,
        activation: instance.config.activation,
        idleTimeoutSeconds: instance.config.idleTimeoutSeconds,
        version: instance.config.version,
        settings: yield* projectSettings(stackId, instance.service, instance.config.settings),
      },
      dependencies: instance.dependencies,
      snapshotSupport: instance.service === "database" ? "supported" : "unsupported",
      endpoints,
      ...(instance.artifactIdentity === undefined
        ? {}
        : { artifactIdentity: instance.artifactIdentity }),
      ...(instance.runtimeIdentity === undefined
        ? {}
        : { runtimeIdentity: instance.runtimeIdentity }),
      ...(initialization === undefined ? {} : { initialization }),
      ...(instance.initializationInputs === null
        ? {}
        : { initializationProfileId: instance.initializationInputs.profileId }),
      data: instance.data,
      ...(instance.bootstrapRecipeId === undefined
        ? {}
        : { bootstrapRecipeId: instance.bootstrapRecipeId }),
      ...(instance.bootstrapInputsId === undefined
        ? {}
        : { bootstrapInputsId: instance.bootstrapInputsId }),
      ...(instance.creationInputsId === undefined
        ? {}
        : { creationInputsId: instance.creationInputsId }),
    };
  });

const descriptorFor = (
  stackId: StackId,
  state: PersistedStackState,
  instance: PersistedServiceInstance,
): Effect.Effect<AnyServiceDescriptor, StackStateInvalidError> => {
  switch (instance.service) {
    case "database":
      return descriptorForKind<"database">(stackId, state, instance);
    case "rest":
      return descriptorForKind<"rest">(stackId, state, instance);
    case "auth":
      return descriptorForKind<"auth">(stackId, state, instance);
    case "realtime":
      return descriptorForKind<"realtime">(stackId, state, instance);
    case "storage":
      return descriptorForKind<"storage">(stackId, state, instance);
    case "functions":
      return descriptorForKind<"functions">(stackId, state, instance);
    case "studio":
      return descriptorForKind<"studio">(stackId, state, instance);
    case "mail":
      return descriptorForKind<"mail">(stackId, state, instance);
    case "analytics":
      return descriptorForKind<"analytics">(stackId, state, instance);
    case "pooler":
      return descriptorForKind<"pooler">(stackId, state, instance);
  }
};

const statusFor = (
  state: PersistedStackState,
  instance: PersistedServiceInstance,
  phase: Phase,
  publishedBindings: ReadonlySet<string> = new Set(),
  recovery?: StackRecovery,
  error?: ServiceFailure,
): ServiceStatus => ({
  id: instance.id,
  service: instance.service,
  ...(instance.name === undefined ? {} : { name: instance.name }),
  enabled: instance.config.enabled,
  intent: instance.intent,
  phase,
  activation: instance.config.activation,
  ...(instance.pendingOperation === null
    ? {}
    : {
        pendingOperation: {
          id: instance.pendingOperation.id,
          kind: instance.pendingOperation.kind,
        },
      }),
  endpoints: state.ports
    .filter(
      (assignment) => assignment.owner === "instance" && assignment.instanceId === instance.id,
    )
    .map((assignment) => {
      const protocol = protocolForInstanceBinding(assignment.binding);
      return {
        binding: assignment.binding,
        protocol,
        address: assignment.address,
        port: assignment.port,
        url: `${protocol}://${assignment.address}:${assignment.port}`,
        availability:
          phase === "ready" || publishedBindings.has(assignment.binding)
            ? ("listening" as const)
            : ("planned" as const),
      };
    }),
  ...(recovery === undefined ? {} : { recovery }),
  ...(error === undefined ? {} : { error }),
});

const instancePlan = (
  state: PersistedStackState,
  id: ServiceInstanceId,
): Effect.Effect<ExecutionPlan, StackError> =>
  createExecutionPlan(state.runtime, state.registry, undefined, new Set([id])).pipe(
    Effect.map((plan) => activeExecutionPlan(plan, dependencyClosure(plan, [id]))),
    Effect.mapError(
      (error) => new StackStateInvalidError({ message: error.message, cause: error }),
    ),
  );

/** Plans all public and private bindings required by one compiled instance closure. */
export const plannedInstancePorts = (
  state: PersistedStackState,
  instance: PersistedServiceInstance,
): Effect.Effect<Pick<PersistedStackState, "ports" | "privatePorts">, StackError> => {
  return createExecutionPlan(state.runtime, state.registry, undefined, new Set([instance.id])).pipe(
    Effect.flatMap((plan) => {
      const occupied = new Set([
        ...state.ports.map((entry) => entry.port),
        ...state.privatePorts.map((entry) => entry.port),
      ]);
      const endpointEntries = Object.entries(instance.config.endpoints).flatMap(
        ([binding, endpoint]) =>
          endpoint === undefined || endpoint.enabled === false ? [] : [{ binding, endpoint }],
      );
      const ports = [...state.ports];
      const privatePorts = [...state.privatePorts];
      let offset = 0;
      const automaticPort = (identity: string): number => {
        let candidate = 20_000;
        for (const character of identity)
          candidate = (candidate * 33 + character.charCodeAt(0)) % 12_000;
        return 20_000 + candidate;
      };
      const api = state.listeners.api;
      if (
        api?.enabled === true &&
        !ports.some((entry) => entry.owner === "stack" && entry.binding === "api")
      ) {
        const requestedPort = api.port;
        if (requestedPort !== undefined && occupied.has(requestedPort))
          return Effect.fail(
            new StackStateInvalidError({
              message: `Port ${requestedPort} is already assigned to another service instance`,
            }),
          );
        let port = requestedPort ?? automaticPort(`${state.identity.stackName}:api`);
        if (requestedPort === undefined)
          while (occupied.has(port)) {
            port = port === 31_999 ? 20_000 : port + 1;
          }
        occupied.add(port);
        ports.push({
          owner: "stack",
          binding: "api",
          address: api.address ?? "127.0.0.1",
          port,
          intent: requestedPort === undefined ? "automatic" : "exact",
        });
      }
      for (const { binding, endpoint } of endpointEntries) {
        const existing = ports.some(
          (entry) =>
            entry.owner === "instance" &&
            entry.instanceId === instance.id &&
            entry.binding === binding,
        );
        if (existing) continue;
        const requestedPort = typeof endpoint.port === "number" ? endpoint.port : undefined;
        if (requestedPort !== undefined && occupied.has(requestedPort))
          return Effect.fail(
            new StackStateInvalidError({
              message: `Port ${requestedPort} is already assigned to another service instance`,
            }),
          );
        let port =
          typeof endpoint.port === "number"
            ? endpoint.port
            : automaticPort(`${instance.id}:${binding}:${offset++}`);
        if (requestedPort === undefined) while (occupied.has(port)) port += 1;
        occupied.add(port);
        ports.push({
          owner: "instance",
          instanceId: instance.id,
          binding,
          address: endpoint.address ?? "127.0.0.1",
          port,
          intent: typeof endpoint.port === "number" ? "exact" : "automatic",
        });
      }
      for (const intent of privateBindingIntentsFor(plan, state)) {
        if (
          privatePorts.some(
            (entry) =>
              entry.instanceId === intent.instanceId &&
              entry.workloadId === intent.workloadId &&
              entry.binding === intent.binding,
          )
        )
          continue;
        let port = automaticPort(
          `${intent.instanceId}:${intent.workloadId}:${intent.binding}:${offset++}`,
        );
        while (occupied.has(port)) port = port === 31_999 ? 20_000 : port + 1;
        occupied.add(port);
        privatePorts.push({ ...intent, port });
      }
      return Effect.succeed({ ports, privatePorts });
    }),
    Effect.mapError(
      (error) => new StackStateInvalidError({ message: error.message, cause: error }),
    ),
  );
};

const changedEndpointBindings = (
  previous: PersistedServiceInstance["config"]["endpoints"],
  next: PersistedServiceInstance["config"]["endpoints"],
): ReadonlySet<string> => {
  const previousEntries = new Map(Object.entries(previous));
  const nextEntries = new Map(Object.entries(next));
  const bindings = new Set([...previousEntries.keys(), ...nextEntries.keys()]);
  return new Set(
    [...bindings].filter(
      (binding) =>
        JSON.stringify(previousEntries.get(binding)) !== JSON.stringify(nextEntries.get(binding)),
    ),
  );
};

export const makeInstanceEngine = (options: InstanceEngineOptions): Effect.Effect<InstanceEngine> =>
  Effect.gen(function* () {
    const phases = yield* Ref.make<ReadonlyMap<ServiceInstanceId, Phase>>(new Map());
    const failures = yield* Ref.make<ReadonlyMap<ServiceInstanceId, ServiceFailure>>(new Map());
    const publishedBindings = yield* Ref.make<ReadonlyMap<ServiceInstanceId, ReadonlySet<string>>>(
      new Map(),
    );
    const statusUpdates = yield* PubSub.unbounded<StatusUpdate>();
    const locks = new Map<ServiceInstanceId, Semaphore.Semaphore>();
    const metadataAdmission = yield* Semaphore.make(1);
    const lockFor = (id: ServiceInstanceId): Effect.Effect<Semaphore.Semaphore> =>
      Effect.sync(() => {
        const current = locks.get(id);
        if (current !== undefined) return current;
        const created = Semaphore.makeUnsafe(1);
        locks.set(id, created);
        return created;
      });
    const read = (): Effect.Effect<PersistedStackState, StackError> =>
      options.stateStore.read(options.stackId).pipe(
        Effect.provideContext(options.context),
        Effect.mapError(
          (error) =>
            new StackStateInvalidError({
              stackId: options.stackId,
              message: error.message,
              cause: error,
            }),
        ),
        Effect.flatMap((state) =>
          state === undefined
            ? Effect.fail(
                new StackStateInvalidError({
                  stackId: options.stackId,
                  message: "Stack state is missing",
                }),
              )
            : Effect.succeed(state),
        ),
      );
    const current = (id: ServiceInstanceId) =>
      read().pipe(
        Effect.flatMap((state) => {
          const instance = state.registry.instances.find((entry) => entry.id === id);
          return instance === undefined
            ? Effect.fail(notFound(id))
            : Effect.succeed({ state, instance });
        }),
      );
    const descriptor = (
      state: PersistedStackState,
      instance: PersistedServiceInstance,
    ): Effect.Effect<AnyServiceDescriptor, StackError> =>
      fingerprintEffectiveConfig(instance, state.security, state.secrets).pipe(
        Effect.provideService(Crypto.Crypto, Context.get(options.context, Crypto.Crypto)),
        Effect.mapError(
          (error) =>
            new StackStateInvalidError({
              stackId: options.stackId,
              message: "Unable to fingerprint service configuration",
              cause: error,
            }),
        ),
        Effect.flatMap((effectiveConfigFingerprint) =>
          descriptorFor(options.stackId, state, instance).pipe(
            Effect.map((projected) => ({
              ...projected,
              ...(effectiveConfigFingerprint === undefined ? {} : { effectiveConfigFingerprint }),
            })),
          ),
        ),
      );
    const phaseFor = (
      id: ServiceInstanceId,
      instance: PersistedServiceInstance,
    ): Effect.Effect<Phase> =>
      Ref.get(phases).pipe(
        Effect.map(
          (all) => all.get(id) ?? (instance.intent === "started" ? "recovery" : "stopped"),
        ),
      );
    const sleepRef = yield* Ref.make<
      (id: ServiceInstanceId, generation: number) => Effect.Effect<void, StackError>
    >(() => Effect.void);
    const idleRetirement = yield* makeIdleRetirement((id, generation) =>
      Ref.get(sleepRef).pipe(
        Effect.flatMap((sleepInstance) => sleepInstance(id, generation)),
        Effect.ignore,
      ),
    ).pipe(Effect.provideService(Scope.Scope, options.scope));
    const cancelIdle = (id: ServiceInstanceId) => idleRetirement.cancel(id);
    const armIdle = (id: ServiceInstanceId): Effect.Effect<void, StackError> =>
      current(id).pipe(
        Effect.flatMap(({ instance }) =>
          phaseFor(id, instance).pipe(
            Effect.flatMap((phase) => {
              const timeout = instance.config.idleTimeoutSeconds;
              return phase === "ready" && typeof timeout === "number"
                ? idleRetirement.arm(id, instance.revisions.intent, timeout)
                : cancelIdle(id);
            }),
          ),
        ),
      );
    // Batch lifecycle requests fence every member during their short admission window. The
    // runtime work remains per-instance, but unrelated operations must observe the batch claim
    // before one member starts waiting on a slow backend.
    type CoordinationClaim = {
      readonly token?: symbol;
      readonly active: number;
      readonly mutation?: Mutation;
      readonly startupControlAllowed?: boolean;
      readonly completion?: Deferred.Deferred<Exit.Exit<void, StackError>, never>;
    };
    const batchClaims = yield* Ref.make<ReadonlyMap<ServiceInstanceId, CoordinationClaim>>(
      new Map(),
    );
    const operationFibers = yield* Ref.make<
      ReadonlyMap<ServiceInstanceId, Fiber.Fiber<unknown, unknown>>
    >(new Map());
    const recovery = yield* Ref.make<ReadonlyMap<ServiceInstanceId, StackRecovery>>(new Map());
    const completeClaim = (
      id: ServiceInstanceId,
      token: symbol | undefined,
      exit: Exit.Exit<unknown, ServiceNotFoundError | StackError>,
      completion?: Deferred.Deferred<Exit.Exit<void, StackError>, never>,
    ) =>
      token === undefined
        ? Effect.void
        : completion !== undefined
          ? Deferred.succeed(completion, voidExit(exit)).pipe(Effect.asVoid)
          : Ref.get(batchClaims).pipe(
              Effect.flatMap((claims) => {
                const claim = claims.get(id);
                return claim?.token === token && claim.completion !== undefined
                  ? Deferred.succeed(claim.completion, voidExit(exit)).pipe(Effect.asVoid)
                  : Effect.void;
              }),
            );
    const claimBatch = (
      ids: ReadonlyArray<ServiceInstanceId>,
      mutation: Mutation,
      rejectActive = false,
      startupControlAllowed = false,
      allowRecoveryCleanup = false,
      allowPendingStarts = false,
    ): Effect.Effect<symbol, StackError> =>
      metadataAdmission.withPermit(
        Effect.gen(function* () {
          const token = Symbol("instance-batch");
          const recoveryIds = allowRecoveryCleanup
            ? yield* Ref.get(recovery).pipe(Effect.map((recoveries) => new Set(recoveries.keys())))
            : new Set<ServiceInstanceId>();
          const pendingStartIds = allowPendingStarts
            ? yield* read().pipe(
                Effect.map(
                  (state) =>
                    new Set(
                      state.registry.instances
                        .filter(
                          (instance) =>
                            instance.pendingOperation?.kind === "start" ||
                            instance.pendingOperation?.kind === "restart",
                        )
                        .map((instance) => instance.id),
                    ),
                ),
              )
            : new Set<ServiceInstanceId>();
          const completions = yield* Effect.forEach(ids, () =>
            Deferred.make<Exit.Exit<void, StackError>>(),
          );
          const selected = new Set(ids);
          if (mutation === "stop" || mutation === "destroy") {
            const state = yield* read();
            for (const id of ids) {
              const dependent = state.registry.instances.find(
                (entry) =>
                  !selected.has(entry.id) &&
                  Object.values(entry.dependencies).includes(id) &&
                  (mutation === "destroy" || entry.intent === "started"),
              );
              if (dependent !== undefined)
                return yield* new StackLifecycleConflictError({
                  stackId: options.stackId,
                  instanceId: id,
                  message:
                    mutation === "destroy"
                      ? `Service instance ${id} has dependent ${dependent.id}`
                      : `Service instance ${id} has active dependents`,
                });
            }
          }
          return yield* Effect.gen(function* () {
            const claimed = yield* Ref.modify(batchClaims, (current) => {
              if (
                ids.some((id) => {
                  const claim = current.get(id);
                  const pendingStartupClaim =
                    pendingStartIds.has(id) &&
                    (claim?.mutation === "start" || claim?.mutation === "restart") &&
                    claim.startupControlAllowed === true;
                  return (
                    claim !== undefined &&
                    ((claim.token !== undefined && !pendingStartupClaim) ||
                      (rejectActive && claim.active > 0))
                  );
                })
              )
                return [false, current] as const;
              const next = new Map(current);
              for (const [index, id] of ids.entries()) {
                const existing = current.get(id);
                const pendingStartupClaim =
                  pendingStartIds.has(id) &&
                  (existing?.mutation === "start" || existing?.mutation === "restart") &&
                  existing.startupControlAllowed === true;
                if (startupControlAllowed && pendingStartupClaim) continue;
                next.set(id, {
                  token,
                  active: current.get(id)?.active ?? 0,
                  mutation,
                  ...(startupControlAllowed ? { startupControlAllowed: true } : {}),
                  ...(completions[index] !== undefined ? { completion: completions[index] } : {}),
                });
              }
              return [true, next] as const;
            });
            if (!claimed) {
              const blocked = yield* Ref.get(batchClaims).pipe(
                Effect.map((current) =>
                  ids.find((id) => {
                    const claim = current.get(id);
                    const pendingStartupClaim =
                      pendingStartIds.has(id) &&
                      (claim?.mutation === "start" || claim?.mutation === "restart") &&
                      claim.startupControlAllowed === true;
                    return (
                      claim !== undefined &&
                      ((claim.token !== undefined && !pendingStartupClaim) ||
                        (rejectActive && claim.active > 0))
                    );
                  }),
                ),
              );
              return yield* new StackLifecycleConflictError({
                stackId: options.stackId,
                ...(blocked === undefined ? {} : { instanceId: blocked }),
                message: "A selected service instance is already part of another batch operation",
              });
            }
            const verified = yield* options.stateStore
              .update<StackError>(options.stackId, (state) => {
                const selected = state.registry.instances.filter((instance) =>
                  ids.includes(instance.id),
                );
                return selected.length === ids.length &&
                  selected.every(
                    (instance) =>
                      instance.pendingOperation === null ||
                      recoveryIds.has(instance.id) ||
                      pendingStartIds.has(instance.id),
                  )
                  ? Effect.succeed(state)
                  : Effect.fail(
                      new StackLifecycleConflictError({
                        stackId: options.stackId,
                        message: "A selected service instance changed during batch admission",
                      }),
                    );
              })
              .pipe(Effect.provideContext(options.context), Effect.asVoid, Effect.exit);
            if (Exit.isFailure(verified)) return yield* Effect.failCause(verified.cause);
            return token;
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : Effect.forEach(completions, (completion) =>
                    Deferred.succeed(completion, voidExit(exit)).pipe(Effect.asVoid),
                  ).pipe(
                    Effect.andThen(
                      Ref.update(batchClaims, (current) => {
                        const next = new Map(current);
                        for (const id of ids) {
                          const claim = next.get(id);
                          if (claim?.token !== token) continue;
                          if (claim.active === 0) next.delete(id);
                          else next.set(id, { active: claim.active });
                        }
                        return next;
                      }),
                    ),
                  ),
            ),
          );
        }),
      );
    const releaseBatch = (ids: ReadonlyArray<ServiceInstanceId>, token: symbol) =>
      Ref.update(batchClaims, (current) => {
        const next = new Map(current);
        for (const id of ids) {
          const claim = next.get(id);
          if (claim?.token !== token) continue;
          if (claim.active === 0) next.delete(id);
          else next.set(id, { active: claim.active });
        }
        return next;
      });
    const acquireTraffic = (
      id: ServiceInstanceId,
      mode: TrafficAdmissionMode = "normal",
    ): Effect.Effect<TrafficLease, ServiceNotFoundError | StackError> =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          if (yield* Ref.get(recovery).pipe(Effect.map((recoveries) => recoveries.has(id))))
            return yield* new StackLifecycleConflictError({
              stackId: options.stackId,
              instanceId: id,
              message: `Service instance ${id} is fenced by a recovery failure`,
            });
          const claim = yield* Ref.get(batchClaims).pipe(Effect.map((claims) => claims.get(id)));
          let completedToken: symbol | undefined;
          let completedCompletion:
            | Deferred.Deferred<Exit.Exit<void, StackError>, never>
            | undefined;
          if (claim?.token !== undefined && mode === "normal") {
            if (claim.completion === undefined)
              return yield* new StackLifecycleConflictError({
                stackId: options.stackId,
                instanceId: id,
                message: `Service instance ${id} is changing lifecycle state`,
              });
            yield* Deferred.await(claim.completion).pipe(Effect.flatMap(joinExit));
            completedToken = claim.token;
            completedCompletion = claim.completion;
            const settled = yield* current(id);
            const settledPhase = yield* phaseFor(id, settled.instance);
            if (
              !settled.instance.config.enabled ||
              settled.instance.intent !== "started" ||
              (settledPhase !== "ready" && settledPhase !== "dormant")
            )
              return yield* new StackLifecycleConflictError({
                stackId: options.stackId,
                instanceId: id,
                message: `Service instance ${id} is no longer ready after lifecycle settlement`,
              });
          }
          const admitted = yield* Ref.modify(batchClaims, (current) => {
            const currentClaim = current.get(id);
            if (
              currentClaim?.token !== undefined &&
              (mode === "normal" || currentClaim.startupControlAllowed !== true) &&
              (currentClaim.token !== completedToken ||
                currentClaim.completion !== completedCompletion)
            )
              return [false, current] as const;
            const next = new Map(current);
            next.set(id, { ...currentClaim, active: (currentClaim?.active ?? 0) + 1 });
            return [true, next] as const;
          });
          if (!admitted)
            return yield* new StackLifecycleConflictError({
              stackId: options.stackId,
              instanceId: id,
              message: `Service instance ${id} is changing lifecycle state`,
            });
          // A traffic lease makes the instance non-idle. Cancel any timer that was armed
          // before admission so releasing this lease starts a fresh idle interval.
          yield* cancelIdle(id);
          return {
            release: Ref.update(batchClaims, (current) => {
              const claim = current.get(id);
              if (claim === undefined || claim.active === 0) return current;
              const next = new Map(current);
              if (claim.active === 1 && claim.token === undefined) next.delete(id);
              else next.set(id, { ...claim, active: claim.active - 1 });
              return next;
            }).pipe(Effect.andThen(armIdle(id).pipe(Effect.ignore))),
          } satisfies TrafficLease;
        }),
      );
    const withDependencyTraffic = <A>(
      input: InstanceRuntimeInput,
      operation: Effect.Effect<A, StackError>,
    ): Effect.Effect<A, StackError> =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forEach(Object.values(input.instance.dependencies), (dependencyId) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.acquireRelease(
                restore(
                  acquireTraffic(dependencyId).pipe(
                    Effect.mapError((error) =>
                      error instanceof ServiceNotFoundError
                        ? new StackLifecycleConflictError({
                            stackId: options.stackId,
                            instanceId: dependencyId,
                            message: `Dependency ${dependencyId} disappeared during startup`,
                          })
                        : error,
                    ),
                  ),
                ),
                (lease) => lease.release,
              ),
            ),
          );
          return yield* operation;
        }),
      );
    const setPhase = (id: ServiceInstanceId, phase: Phase) =>
      Ref.update(phases, (all) => new Map(all).set(id, phase)).pipe(
        Effect.andThen(PubSub.publish(statusUpdates, { id, destroyed: false })),
        Effect.andThen(options.publishStatus ?? Effect.void),
      );
    const clearFailure = (id: ServiceInstanceId) =>
      Ref.update(failures, (all) => {
        const next = new Map(all);
        next.delete(id);
        return next;
      });
    const retainFailure = (
      id: ServiceInstanceId,
      operationId: string,
      state: PersistedStackState,
      error: StackError,
    ) =>
      Ref.update(failures, (all) =>
        new Map(all).set(id, serviceFailureFor(id, operationId, state, error)),
      );
    const markRecovery = (
      id: ServiceInstanceId,
      pending: PersistedPendingOperation,
      error: StackError,
    ): Effect.Effect<void, never> =>
      Ref.update(recovery, (recoveries) => {
        const next = new Map(recoveries);
        next.set(id, {
          operation:
            pending.kind === "destroy" ||
            pending.kind === "restoreSnapshot" ||
            pending.kind === "exportSnapshot"
              ? "destroy"
              : "stop",
          message: `Recovery of ${pending.kind} operation ${pending.id} failed: ${error.message}`,
        });
        return next;
      }).pipe(Effect.andThen(setPhase(id, "recovery")), Effect.ignore);
    const joinStartExit = <A>(
      id: ServiceInstanceId,
      exit: Exit.Exit<A, ServiceNotFoundError | StackError>,
    ): Effect.Effect<A, ServiceNotFoundError | StackError> =>
      Exit.isSuccess(exit)
        ? Effect.succeed(exit.value)
        : Cause.hasInterruptsOnly(exit.cause)
          ? Effect.fail(
              new StackLifecycleConflictError({
                stackId: options.stackId,
                instanceId: id,
                message: `Service instance ${id} was superseded during startup`,
              }),
            )
          : Effect.failCause(exit.cause);
    const publishBindings = (
      id: ServiceInstanceId,
      publications: ReadonlyArray<RuntimeBindingPublication>,
    ): Effect.Effect<void, StackError> =>
      (options.publishEndpoints === undefined
        ? Effect.void
        : options.publishEndpoints(id, publications)
      ).pipe(
        Effect.andThen(
          Ref.update(publishedBindings, (current) => {
            if (publications.length === 0) return current;
            const next = new Map(current);
            const existing = next.get(id) ?? new Set<string>();
            next.set(id, new Set([...existing, ...publications.map(({ binding }) => binding)]));
            return next;
          }),
        ),
      );
    const unpublishBindings = (
      id: ServiceInstanceId,
      preserveListener = false,
    ): Effect.Effect<void, StackError> =>
      (options.unpublishEndpoints === undefined
        ? Effect.void
        : options.unpublishEndpoints(id, preserveListener)
      ).pipe(
        Effect.andThen(
          Ref.update(publishedBindings, (current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          }),
        ),
      );
    const startAndPublish = (
      input: InstanceRuntimeInput,
    ): Effect.Effect<ReadonlyArray<RuntimeBindingPublication>, StackError> =>
      options.runtime.start(input).pipe(
        Effect.flatMap((publications) =>
          publishBindings(input.instance.id, publications).pipe(
            Effect.as(publications),
            Effect.catch((publicationError) =>
              Effect.gen(function* () {
                const runtimeCleanup = yield* options.runtime.stop(input).pipe(Effect.exit);
                const ingressCleanup = yield* unpublishBindings(input.instance.id).pipe(
                  Effect.exit,
                );
                const cleanupExit = Exit.isFailure(runtimeCleanup)
                  ? runtimeCleanup
                  : Exit.isFailure(ingressCleanup)
                    ? ingressCleanup
                    : undefined;
                if (cleanupExit !== undefined) {
                  const cleanupError = errorFromCause(cleanupExit.cause);
                  return yield* new StackCleanupError({
                    message: `Startup publication failed and cleanup was not proven: ${cleanupError.message}`,
                    cause: cleanupError,
                  });
                }
                return yield* publicationError;
              }),
            ),
          ),
        ),
      );
    const run = <A>(
      id: ServiceInstanceId,
      mutation: Mutation,
      operation: (input: InstanceRuntimeInput) => Effect.Effect<A, StackError>,
      settle: (
        state: PersistedStackState,
        instance: PersistedServiceInstance,
        value: A,
      ) => Effect.Effect<PersistedStackState, StackError>,
      skip?: (current: {
        readonly state: PersistedStackState;
        readonly instance: PersistedServiceInstance;
      }) => Effect.Effect<A, ServiceNotFoundError | StackError>,
      shouldSkip?: (current: {
        readonly state: PersistedStackState;
        readonly instance: PersistedServiceInstance;
      }) => Effect.Effect<boolean>,
      preflight?: (current: {
        readonly state: PersistedStackState;
        readonly instance: PersistedServiceInstance;
      }) => Effect.Effect<void, StackError>,
      batchToken?: symbol,
      afterSettle?: (value: A) => Effect.Effect<A, StackError>,
      replacement?: InstanceRestartCandidate,
      skipIdleCancel?: boolean,
    ): Effect.Effect<A, ServiceNotFoundError | StackError> =>
      Effect.flatMap(lockFor(id), (lock) => {
        // Snapshot ownership is a hard fence in both directions. Do this read before taking
        // the instance semaphore so a lifecycle request fails promptly instead of queueing behind
        // an export/restore that may be waiting on a caller-owned barrier.
        const rejectSnapshotConflict =
          mutation === "exportSnapshot" || mutation === "restoreSnapshot"
            ? Effect.void
            : current(id).pipe(
                Effect.flatMap(({ instance }) =>
                  instance.pendingOperation?.kind === "exportSnapshot" ||
                  instance.pendingOperation?.kind === "restoreSnapshot"
                    ? Ref.get(recovery).pipe(
                        Effect.flatMap((recoveries) =>
                          mutation === "destroy" && recoveries.get(id)?.operation === "destroy"
                            ? Effect.void
                            : Effect.fail(
                                new StackLifecycleConflictError({
                                  stackId: options.stackId,
                                  message: `Service instance ${id} has a snapshot operation in progress`,
                                }),
                              ),
                        ),
                      )
                    : Effect.void,
                ),
              );
        const rejectBatchConflict = Ref.get(batchClaims).pipe(
          Effect.flatMap((claims) => {
            const claim = claims.get(id);
            const owner = claim?.token;
            return owner === undefined ||
              owner === batchToken ||
              owner === handoffToken ||
              (batchToken === undefined && mutation === "start" && claim?.mutation === "start")
              ? Effect.void
              : Effect.fail(
                  new StackLifecycleConflictError({
                    stackId: options.stackId,
                    instanceId: id,
                    message: `Service instance ${id} is part of another batch operation`,
                  }),
                );
          }),
        );
        const execute = (input: InstanceRuntimeInput) =>
          Effect.gen(function* () {
            const { instance } = input;
            const operationId = input.operation.id;
            yield* setPhase(
              id,
              mutation === "start" || mutation === "restart" ? "starting" : "stopping",
            );
            return yield* operation(input).pipe(
              Effect.flatMap((value) =>
                options.stateStore
                  .update(options.stackId, (state) => {
                    const current = state.registry.instances.find((entry) => entry.id === id);
                    const pending = current?.pendingOperation;
                    if (
                      current === undefined ||
                      pending === null ||
                      pending?.id !== operationId ||
                      pending.generation !== instance.revisions.intent
                    )
                      return Effect.fail(
                        new StackLifecycleConflictError({
                          stackId: options.stackId,
                          message: `Service instance ${id} changed during ${mutation}`,
                        }),
                      );
                    return settle(state, current, value);
                  })
                  .pipe(
                    Effect.provideContext(options.context),
                    Effect.andThen(
                      Ref.update(recovery, (recoveries) => {
                        const next = new Map(recoveries);
                        next.delete(id);
                        return next;
                      }),
                    ),
                    Effect.andThen(clearFailure(id)),
                    Effect.flatMap(() =>
                      afterSettle === undefined ? Effect.succeed(value) : afterSettle(value),
                    ),
                  ),
              ),
              Effect.tap(() =>
                setPhase(
                  id,
                  mutation === "start" || mutation === "restart"
                    ? mutation === "restart" && replacement?.startImmediately === false
                      ? replacement.desiredIntent === "stopped"
                        ? "stopped"
                        : "dormant"
                      : "ready"
                    : mutation === "sleep"
                      ? "dormant"
                      : "stopped",
                ),
              ),
              Effect.tap(() =>
                skipIdleCancel
                  ? Effect.void
                  : mutation === "start" || mutation === "restart"
                    ? armIdle(id)
                    : cancelIdle(id),
              ),
              Effect.catchCause((cause) => {
                const errorOption = Cause.findErrorOption(cause);
                if (Option.isNone(errorOption) && !Cause.hasDies(cause))
                  return Effect.failCause(cause);
                const error = Option.isSome(errorOption)
                  ? errorOption.value
                  : errorFromCause(cause);
                const retainJournal =
                  Cause.hasDies(cause) ||
                  Cause.hasInterrupts(cause) ||
                  error instanceof StackCleanupError ||
                  error instanceof UncertainOperationError ||
                  mutation === "stop" ||
                  mutation === "destroy" ||
                  mutation === "sleep";
                const cleanup = retainJournal
                  ? Effect.void
                  : options.stateStore
                      .update(options.stackId, (state) => {
                        const current = state.registry.instances.find((entry) => entry.id === id);
                        const pending = current?.pendingOperation;
                        if (
                          current === undefined ||
                          pending === null ||
                          pending?.id !== operationId ||
                          pending.generation !== instance.revisions.intent
                        )
                          return Effect.succeed(state);
                        return Effect.succeed({
                          ...state,
                          registry: {
                            ...state.registry,
                            instances: state.registry.instances.map((entry) =>
                              entry.id === id
                                ? {
                                    ...entry,
                                    ...(mutation === "start" ? { intent: "stopped" as const } : {}),
                                    pendingOperation: null,
                                  }
                                : entry,
                            ),
                          },
                        });
                      })
                      .pipe(Effect.provideContext(options.context), Effect.asVoid);
                const markFailure =
                  retainJournal && input.instance.pendingOperation !== null
                    ? markRecovery(id, input.instance.pendingOperation, error)
                    : Effect.void;
                const bookkeeping = cleanup.pipe(
                  Effect.andThen(retainFailure(id, operationId, input.state, error)),
                  Effect.andThen(markFailure),
                  Effect.andThen(retainJournal ? Effect.void : setPhase(id, "failed")),
                );
                return Effect.exit(bookkeeping).pipe(
                  Effect.flatMap((exit) =>
                    Exit.isFailure(exit)
                      ? Effect.failCause(Cause.combine(cause, exit.cause))
                      : Effect.failCause(cause),
                  ),
                );
              }),
            );
          });
        const ownerBody = metadataAdmission
          .withPermit(
            Effect.gen(function* () {
              const admitted = yield* current(id);
              const recoveryCleanup =
                mutation === "stop" || mutation === "destroy"
                  ? yield* Ref.get(recovery).pipe(Effect.map((recoveries) => recoveries.get(id)))
                  : undefined;
              if (mutation === "stop" && recoveryCleanup?.operation === "destroy")
                return yield* new StackLifecycleConflictError({
                  stackId: options.stackId,
                  instanceId: id,
                  message: `Service instance ${id} requires destroy recovery before activation can be unfenced`,
                });
              const replacementEnabled = replacement?.instance.config.enabled;
              const startsWorkload =
                mutation === "start" ||
                (mutation === "restart" &&
                  replacement?.startImmediately !== false &&
                  replacement?.desiredIntent !== "stopped");
              if (
                startsWorkload &&
                (replacementEnabled ?? admitted.instance.config.enabled) === false
              )
                return yield* new StackLifecycleConflictError({
                  stackId: options.stackId,
                  instanceId: id,
                  message: `Disabled service instance ${id} cannot be started`,
                });
              if (
                startsWorkload &&
                (yield* Ref.get(recovery).pipe(Effect.map((recoveries) => recoveries.has(id))))
              )
                return yield* new StackLifecycleConflictError({
                  stackId: options.stackId,
                  instanceId: id,
                  message: `Service instance ${id} is fenced by a recovery failure`,
                });
              if (startsWorkload || replacement !== undefined) {
                const claims = yield* Ref.get(batchClaims);
                const dependencies =
                  replacement?.instance.dependencies ?? admitted.instance.dependencies;
                const blockedDependency = [...claims].find(
                  ([dependencyId, claim]) =>
                    Object.values(dependencies).includes(dependencyId) &&
                    claim?.mutation !== undefined &&
                    claim.mutation !== "start" &&
                    claim.token !== batchToken,
                )?.[0];
                if (blockedDependency !== undefined)
                  return yield* new StackLifecycleConflictError({
                    stackId: options.stackId,
                    instanceId: blockedDependency,
                    message: `Dependency ${blockedDependency} is changing lifecycle state`,
                  });
              }
              if (
                (mutation === "exportSnapshot" || mutation === "restoreSnapshot") &&
                (admitted.instance.intent !== "stopped" ||
                  admitted.instance.pendingOperation !== null)
              )
                return yield* new StackLifecycleConflictError({
                  stackId: options.stackId,
                  message: `Snapshot operation requires stopped service instance ${id}`,
                });
              if (preflight !== undefined) yield* preflight(admitted);
              if (skip !== undefined && shouldSkip !== undefined && (yield* shouldSkip(admitted)))
                return { kind: "value" as const, value: yield* skip(admitted) };
              // Admit the intent and endpoint plan in one transaction. Once the journal is written,
              // every later failure path below must settle that same operation rather than strand it.
              const preadmitted = replacement?.admission;
              const operationId =
                preadmitted?.operationId ??
                (yield* Context.get(options.context, Crypto.Crypto).randomUUIDv4.pipe(
                  Effect.mapError(
                    (error) =>
                      new StackStateInvalidError({
                        stackId: options.stackId,
                        message: `Unable to allocate operation identity: ${error.message}`,
                        cause: error,
                      }),
                  ),
                ));
              const accepted = yield* preadmitted !== undefined
                ? read().pipe(
                    Effect.flatMap((state) => {
                      const instance = state.registry.instances.find((entry) => entry.id === id);
                      const pending = instance?.pendingOperation;
                      return instance !== undefined &&
                        pending?.id === preadmitted.operationId &&
                        pending.generation === preadmitted.generation
                        ? Effect.succeed(state)
                        : Effect.fail(
                            new StackLifecycleConflictError({
                              stackId: options.stackId,
                              instanceId: id,
                              message: `Service instance ${id} no longer owns its admitted restart`,
                            }),
                          );
                    }),
                  )
                : options.stateStore
                    .update<StackError>(options.stackId, (state) => {
                      const instance = state.registry.instances.find((entry) => entry.id === id);
                      if (instance === undefined) return Effect.fail(notFound(id));
                      if (
                        replacement !== undefined &&
                        (mutation !== "restart" ||
                          replacement.previous.instance.id !== instance.id ||
                          replacement.previous.instance.revisions.config !==
                            instance.revisions.config ||
                          replacement.previous.instance.revisions.intent !==
                            instance.revisions.intent)
                      )
                        return Effect.fail(
                          new StackLifecycleConflictError({
                            stackId: options.stackId,
                            instanceId: id,
                            message: `Service instance ${id} changed before its restart was admitted`,
                          }),
                        );
                      if (instance.pendingOperation !== null && !recoveryCleanup)
                        return Effect.fail(
                          new StackLifecycleConflictError({
                            stackId: options.stackId,
                            message: `Service instance ${id} already has a pending operation`,
                          }),
                        );
                      const generation = instance.revisions.intent + 1;
                      const pendingOperation = {
                        id: operationId,
                        kind: mutation,
                        generation,
                        ownerSessionId: options.ownerSessionId,
                        phase: "running" as const,
                      };
                      const nextInstanceValue =
                        mutation === "restart" && replacement !== undefined
                          ? {
                              ...replacement.instance,
                              id: instance.id,
                              service: instance.service,
                              intent: replacement.desiredIntent ?? ("started" as const),
                              resources: instance.resources,
                              data: instance.data,
                              revisions: {
                                ...instance.revisions,
                                config: instance.revisions.config + 1,
                                intent: generation,
                              },
                              pendingOperation,
                            }
                          : mutation === "start"
                            ? {
                                ...instance,
                                intent: "started" as const,
                                revisions: { ...instance.revisions, intent: generation },
                                pendingOperation,
                              }
                            : mutation === "stop" || mutation === "destroy"
                              ? {
                                  ...instance,
                                  intent: "stopped" as const,
                                  revisions: { ...instance.revisions, intent: generation },
                                  pendingOperation,
                                }
                              : {
                                  ...instance,
                                  revisions: { ...instance.revisions, intent: generation },
                                  pendingOperation,
                                };
                      const nextInstance = Schema.decodeUnknownEffect(
                        PersistedServiceInstanceSchema,
                      )(nextInstanceValue).pipe(
                        Effect.mapError(
                          (error) =>
                            new StackStateInvalidError({
                              stackId: options.stackId,
                              message: `Restarted service instance failed validation: ${String(error)}`,
                              cause: error,
                            }),
                        ),
                      );
                      return nextInstance.pipe(
                        Effect.flatMap((resolvedInstance) => {
                          const nextState = {
                            ...state,
                            registry: {
                              ...state.registry,
                              instances: state.registry.instances.map((entry) =>
                                entry.id === id ? resolvedInstance : entry,
                              ),
                            },
                          };
                          const withSecrets =
                            mutation === "restart" && replacement !== undefined
                              ? resolveSecrets(
                                  {
                                    declarations: [
                                      ...Object.entries(state.secrets)
                                        .filter(
                                          ([slot]) =>
                                            !replacement.secretSlots.some(
                                              (candidate) => candidate.slot === slot,
                                            ),
                                        )
                                        .map(([slot, entry]) => ({
                                          slot,
                                          policy: entry.policy,
                                          value: Redacted.make(entry.value),
                                        })),
                                      ...replacement.secretSlots,
                                    ],
                                  },
                                  Object.fromEntries(
                                    Object.entries(state.secrets).filter(
                                      ([slot]) =>
                                        !replacement.secretSlots.some(
                                          (candidate) => candidate.slot === slot,
                                        ),
                                    ),
                                  ),
                                  "stopped",
                                ).pipe(
                                  Effect.provideContext(options.context),
                                  Effect.map((resolved) => ({
                                    ...nextState,
                                    secrets: resolved.persisted,
                                  })),
                                )
                              : Effect.succeed(nextState);
                          return withSecrets.pipe(
                            Effect.flatMap((resolved) => {
                              if (mutation !== "start" && mutation !== "restart")
                                return Effect.succeed(resolved);
                              const changed =
                                mutation === "restart"
                                  ? changedEndpointBindings(
                                      replacement?.previous.instance.config.endpoints ??
                                        instance.config.endpoints,
                                      resolvedInstance.config.endpoints,
                                    )
                                  : new Set<string>();
                              const replanningState =
                                changed.size === 0
                                  ? resolved
                                  : {
                                      ...resolved,
                                      ports: resolved.ports.filter(
                                        (assignment) =>
                                          assignment.owner !== "instance" ||
                                          assignment.instanceId !== id ||
                                          !changed.has(assignment.binding),
                                      ),
                                    };
                              return plannedInstancePorts(replanningState, resolvedInstance).pipe(
                                Effect.map((ports) => ({ ...resolved, ...ports })),
                              );
                            }),
                          );
                        }),
                      );
                    })
                    .pipe(
                      Effect.provideContext(options.context),
                      Effect.mapError((error) =>
                        error instanceof ServiceNotFoundError || isStackError(error)
                          ? error
                          : new StackStateInvalidError({
                              stackId: options.stackId,
                              message: String(error),
                              cause: error,
                            }),
                      ),
                    );
              const preparedState = accepted;
              const instance = preparedState.registry.instances.find((entry) => entry.id === id);
              if (instance === undefined) return yield* notFound(id);
              const plan = yield* instancePlan(preparedState, id);
              const publishStartupBindings =
                options.publishEndpoints === undefined
                  ? undefined
                  : (publications: ReadonlyArray<RuntimeBindingPublication>) =>
                      current(id).pipe(
                        Effect.flatMap(({ instance: currentInstance }) =>
                          currentInstance.pendingOperation?.id === operationId &&
                          currentInstance.pendingOperation.generation === instance.revisions.intent
                            ? publishBindings(id, publications).pipe(
                                Effect.andThen(setPhase(id, "starting")),
                              )
                            : Effect.fail(
                                new StackLifecycleConflictError({
                                  stackId: options.stackId,
                                  instanceId: id,
                                  message: `Startup publication ${operationId} is no longer owned by this operation`,
                                }),
                              ),
                        ),
                      );
              const input: InstanceRuntimeInput = {
                stackId: options.stackId,
                state: preparedState,
                instance,
                plan,
                operation: { id: operationId, generation: instance.revisions.intent },
                publishStartupBindings,
              };
              return { kind: "input" as const, input };
            }),
          )
          .pipe(
            Effect.flatMap((admitted) =>
              admitted.kind === "input" ? execute(admitted.input) : Effect.succeed(admitted.value),
            ),
          );
        const admittedOwner =
          mutation === "exportSnapshot" || mutation === "restoreSnapshot"
            ? lock
                .withPermitsIfAvailable(1)(ownerBody)
                .pipe(
                  Effect.flatMap((result) =>
                    Option.isSome(result)
                      ? Effect.succeed(result.value)
                      : Effect.fail(
                          new StackLifecycleConflictError({
                            stackId: options.stackId,
                            message: `Service instance ${id} has another operation in progress`,
                          }),
                        ),
                  ),
                )
            : lock.withPermit(ownerBody);
        let handoffToken: symbol | undefined;
        let supersededStart:
          | {
              readonly fiber: Fiber.Fiber<unknown, unknown>;
              readonly pending: PersistedPendingOperation;
            }
          | undefined;
        const ownClaim =
          batchToken !== undefined
            ? Effect.sync(() => ({
                token: handoffToken ?? batchToken,
                owned: handoffToken !== undefined,
              }))
            : Ref.get(batchClaims).pipe(
                Effect.flatMap((claims) => {
                  const existing = claims.get(id)?.token;
                  if (handoffToken !== undefined)
                    return Effect.succeed({ token: handoffToken, owned: true });
                  if (existing !== undefined) {
                    return mutation === "start"
                      ? Effect.succeed({ token: existing, owned: false })
                      : Effect.fail(
                          new StackLifecycleConflictError({
                            stackId: options.stackId,
                            instanceId: id,
                            message: `Service instance ${id} is already changing lifecycle state`,
                          }),
                        );
                  }
                  return Ref.get(recovery).pipe(
                    Effect.flatMap((recoveries) =>
                      claimBatch(
                        [id],
                        mutation,
                        mutation === "sleep",
                        mutation === "start" || mutation === "restart",
                        (mutation === "stop" || mutation === "destroy") && recoveries.has(id),
                        false,
                      ),
                    ),
                    Effect.map((token) => ({ token, owned: true })),
                  );
                }),
              );
        const supersedeStart = (
          restore: <A>(effect: Effect.Effect<A, StackError>) => Effect.Effect<A, StackError>,
        ) =>
          mutation === "stop" || mutation === "destroy"
            ? Effect.gen(function* () {
                const permit = yield* restore(metadataAdmission.take(1));
                return yield* Effect.gen(function* () {
                  const admitted = yield* restore(current(id));
                  const { instance } = admitted;
                  if (preflight !== undefined) yield* preflight(admitted);
                  if (
                    instance.pendingOperation?.kind !== "start" &&
                    instance.pendingOperation?.kind !== "restart"
                  )
                    return;
                  const pending = instance.pendingOperation;
                  const oldToken = yield* restore(
                    Ref.get(batchClaims).pipe(Effect.map((claims) => claims.get(id)?.token)),
                  );
                  const fiber = yield* restore(
                    Ref.get(operationFibers).pipe(Effect.map((fibers) => fibers.get(id))),
                  );
                  if (fiber === undefined) {
                    const recoverable = yield* Ref.get(recovery).pipe(
                      Effect.map((recoveries) => recoveries.has(id)),
                    );
                    if (!recoverable)
                      return yield* new StackLifecycleConflictError({
                        stackId: options.stackId,
                        instanceId: id,
                        message: `Service instance ${id} has a pending startup without a live owner`,
                      });
                    return;
                  }
                  const replacementToken = Symbol("instance-stop-handoff");
                  const replacementCompletion = yield* Deferred.make<Exit.Exit<void, StackError>>();
                  const handedOff = yield* Ref.modify(batchClaims, (claims) => {
                    const claim = claims.get(id);
                    const canHandoff =
                      claim?.token !== undefined &&
                      claim.token === oldToken &&
                      (claim.startupControlAllowed === true ||
                        (batchToken !== undefined && claim.token === batchToken));
                    return canHandoff
                      ? [
                          true,
                          new Map(claims).set(id, {
                            token: replacementToken,
                            active: claim.active,
                            mutation,
                            completion:
                              batchToken !== undefined && claim.token === batchToken
                                ? (claim.completion ?? replacementCompletion)
                                : replacementCompletion,
                          }),
                        ]
                      : [false, claims];
                  });
                  if (!handedOff)
                    return yield* new StackLifecycleConflictError({
                      stackId: options.stackId,
                      instanceId: id,
                      message: `Service instance ${id} is already changing lifecycle state`,
                    });
                  handoffToken = replacementToken;
                  supersededStart = { fiber, pending };
                }).pipe(Effect.ensuring(metadataAdmission.release(permit).pipe(Effect.asVoid)));
              })
            : Effect.void;
        return rejectSnapshotConflict.pipe(
          Effect.flatMap(() =>
            Effect.uninterruptibleMask((restore) =>
              supersedeStart(restore).pipe(
                Effect.andThen(rejectBatchConflict),
                Effect.flatMap(() =>
                  supersededStart === undefined ? restore(ownClaim) : ownClaim,
                ),
                Effect.flatMap(({ token, owned }) =>
                  Effect.gen(function* () {
                    let ownerFiber: Fiber.Fiber<unknown, unknown> | undefined;
                    const claimCompletion = yield* Ref.get(batchClaims).pipe(
                      Effect.map((claims) => {
                        const claim = claims.get(id);
                        return claim?.token === token ? claim.completion : undefined;
                      }),
                    );
                    const handoff =
                      supersededStart === undefined
                        ? Effect.void
                        : Effect.gen(function* () {
                            const superseded = supersededStart;
                            if (superseded === undefined) return;
                            const { fiber, pending } = superseded;
                            yield* restore(Fiber.interrupt(fiber));
                            yield* restore(
                              options.stateStore
                                .update(options.stackId, (state) => {
                                  const currentInstance = state.registry.instances.find(
                                    (entry) => entry.id === id,
                                  );
                                  const currentPending = currentInstance?.pendingOperation;
                                  return currentPending?.id === pending.id &&
                                    currentPending.generation === pending.generation
                                    ? Effect.succeed({
                                        ...state,
                                        registry: {
                                          ...state.registry,
                                          instances: state.registry.instances.map((entry) =>
                                            entry.id === id
                                              ? { ...entry, pendingOperation: null }
                                              : entry,
                                          ),
                                        },
                                      })
                                    : Effect.succeed(state);
                                })
                                .pipe(Effect.provideContext(options.context), Effect.asVoid),
                            ).pipe(
                              Effect.catch((error) =>
                                markRecovery(id, pending, error).pipe(
                                  Effect.andThen(Effect.fail(error)),
                                ),
                              ),
                            );
                          });
                    const owner = handoff.pipe(
                      Effect.andThen(admittedOwner),
                      Effect.onExit((exit) =>
                        completeClaim(id, token, exit, claimCompletion).pipe(
                          Effect.andThen(
                            Ref.update(operationFibers, (fibers) => {
                              const next = new Map(fibers);
                              if (next.get(id) === ownerFiber) next.delete(id);
                              return next;
                            }),
                          ),
                        ),
                      ),
                      Effect.ensuring(owned ? releaseBatch([id], token) : Effect.void),
                    );
                    const fiber = yield* Effect.forkIn(restore(owner), options.scope, {
                      startImmediately: false,
                    });
                    ownerFiber = fiber;
                    yield* Ref.update(operationFibers, (fibers) => {
                      const next = new Map(fibers);
                      next.set(id, fiber);
                      return next;
                    });
                    return yield* restore(Fiber.join(fiber));
                  }),
                ),
              ),
            ),
          ),
        );
      });
    const get = (ref: { readonly id: ServiceInstanceId } | { readonly name: string }) =>
      read().pipe(
        Effect.flatMap((state) => {
          const instance = findInstance(state.registry, ref);
          return instance === undefined
            ? Effect.fail(
                new ServiceNotFoundError({
                  message: `Service instance ${"id" in ref ? ref.id : ref.name} was not found`,
                  ...("id" in ref ? { instanceId: ref.id } : {}),
                }),
              )
            : Effect.succeed(instance);
        }),
      );
    const list = read().pipe(
      Effect.flatMap((state) =>
        Effect.forEach(state.registry.instances, (instance) => descriptor(state, instance)),
      ),
    );
    const describe = (ref: { readonly id: ServiceInstanceId } | { readonly name: string }) =>
      read().pipe(
        Effect.flatMap((state) => {
          const instance = findInstance(state.registry, ref);
          return instance === undefined
            ? Effect.fail(
                new ServiceNotFoundError({
                  message: `Service instance ${"id" in ref ? ref.id : ref.name} was not found`,
                  ...("id" in ref ? { instanceId: ref.id } : {}),
                }),
              )
            : descriptor(state, instance);
        }),
      );
    const status = (id: ServiceInstanceId) =>
      current(id).pipe(
        Effect.flatMap(({ state, instance }) =>
          phaseFor(id, instance).pipe(
            Effect.flatMap((phase) =>
              Ref.get(publishedBindings).pipe(
                Effect.flatMap((bindings) =>
                  Ref.get(recovery).pipe(
                    Effect.flatMap((recoveries) =>
                      Ref.get(failures).pipe(
                        Effect.map((errors) =>
                          statusFor(
                            state,
                            instance,
                            phase,
                            bindings.get(id) ?? new Set(),
                            recoveries.get(id),
                            errors.get(id),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    const followStatus = (id: ServiceInstanceId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(statusUpdates);
          const initial = yield* status(id);
          const latest = yield* Ref.make(initial);
          const updates = Stream.fromSubscription(subscription).pipe(
            Stream.filter((updated) => updated.id === id),
            Stream.takeUntil((updated) => updated.destroyed),
            Stream.mapEffect((updated) =>
              updated.destroyed
                ? Ref.get(latest)
                : status(id).pipe(
                    Effect.tap((next) => Ref.set(latest, next)),
                    Effect.catchTag("ServiceNotFoundError", () => Ref.get(latest)),
                  ),
            ),
          );
          return Stream.concat(Stream.succeed(initial), updates);
        }),
      );
    const startsInFlight = new Map<
      ServiceInstanceId,
      Deferred.Deferred<Exit.Exit<ServiceStatus, ServiceNotFoundError | StackError>, never>
    >();
    const startOperationBody = (
      id: ServiceInstanceId,
      batchToken?: symbol,
    ): Effect.Effect<ServiceStatus, ServiceNotFoundError | StackError> =>
      run(
        id,
        "start",
        (input) =>
          Effect.gen(function* () {
            yield* Effect.forEach(Object.values(input.instance.dependencies), (dependencyId) =>
              current(dependencyId).pipe(
                Effect.flatMap(({ instance: dependency }) =>
                  phaseFor(dependency.id, dependency).pipe(
                    Effect.flatMap((phase) =>
                      phase === "ready"
                        ? Effect.void
                        : input.state.registry.instances.some(
                              (entry) =>
                                entry.id === dependency.id &&
                                (entry.pendingOperation?.kind === "stop" ||
                                  entry.pendingOperation?.kind === "destroy"),
                            )
                          ? Effect.fail(
                              new StackLifecycleConflictError({
                                stackId: options.stackId,
                                instanceId: dependency.id,
                                message: `Dependency ${dependency.id} was superseded during startup`,
                              }),
                            )
                          : startOperation(dependency.id, batchToken).pipe(Effect.asVoid),
                    ),
                  ),
                ),
              ),
            );
            const publications = yield* withDependencyTraffic(input, startAndPublish(input));
            return publications;
          }).pipe(Effect.andThen(status(id))),
        (state, instance) =>
          Effect.succeed({
            ...state,
            registry: {
              ...state.registry,
              instances: state.registry.instances.map((entry) =>
                entry.id === instance.id ? { ...entry, pendingOperation: null } : entry,
              ),
            },
          }),
        () => status(id),
        ({ instance }) => phaseFor(id, instance).pipe(Effect.map((phase) => phase === "ready")),
        undefined,
        batchToken,
      );
    const startOperation = (id: ServiceInstanceId, batchToken?: symbol) =>
      Effect.suspend(() => {
        const existing = startsInFlight.get(id);
        if (existing !== undefined)
          return Deferred.await(existing).pipe(
            Effect.flatMap((exit) => joinStartExit(id, exit)),
            Effect.andThen(status(id)),
          );
        return Effect.uninterruptibleMask((restore) =>
          Deferred.make<Exit.Exit<ServiceStatus, ServiceNotFoundError | StackError>>().pipe(
            Effect.flatMap((completion) => {
              startsInFlight.set(id, completion);
              const owner = startOperationBody(id, batchToken).pipe(
                Effect.onExit((exit) =>
                  Deferred.succeed(completion, exit).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        if (startsInFlight.get(id) === completion) startsInFlight.delete(id);
                      }),
                    ),
                  ),
                ),
              );
              return Effect.forkIn(restore(owner), options.scope, { startImmediately: false }).pipe(
                Effect.flatMap((fiber) =>
                  restore(Fiber.await(fiber)).pipe(
                    Effect.flatMap((exit) => joinStartExit(id, exit)),
                  ),
                ),
              );
            }),
          ),
        );
      });
    const start = (id: ServiceInstanceId) => startOperation(id).pipe(Effect.andThen(status(id)));
    const stop = (id: ServiceInstanceId, batchToken?: symbol) =>
      run(
        id,
        "stop",
        (input) =>
          options.runtime.stop(input).pipe(Effect.andThen(unpublishBindings(input.instance.id))),
        (state, instance) =>
          Effect.succeed({
            ...state,
            registry: {
              ...state.registry,
              instances: state.registry.instances.map((entry) =>
                entry.id === instance.id ? { ...entry, pendingOperation: null } : entry,
              ),
            },
          }),
        undefined,
        undefined,
        ({ state, instance }) =>
          state.registry.instances.some(
            (dependent) =>
              dependent.intent === "started" &&
              batchToken === undefined &&
              Object.values(dependent.dependencies).includes(instance.id),
          )
            ? Effect.fail(
                new StackLifecycleConflictError({
                  stackId: options.stackId,
                  instanceId: id,
                  message: `Service instance ${id} has active dependents`,
                }),
              )
            : Effect.void,
        batchToken,
      ).pipe(Effect.andThen(status(id)));
    const sleep = (
      id: ServiceInstanceId,
      batchToken?: symbol,
      expectedGeneration?: number,
      fromIdle?: boolean,
    ) =>
      run(
        id,
        "sleep",
        (input) =>
          options.runtime
            .stop(input)
            .pipe(
              Effect.andThen(unpublishBindings(input.instance.id, true)),
              Effect.andThen(status(id)),
            ),
        (state, instance) =>
          Effect.succeed({
            ...state,
            registry: {
              ...state.registry,
              instances: state.registry.instances.map((entry) =>
                entry.id === instance.id ? { ...entry, pendingOperation: null } : entry,
              ),
            },
          }),
        () => status(id),
        ({ instance }) => phaseFor(id, instance).pipe(Effect.map((phase) => phase === "dormant")),
        ({ state, instance }) =>
          phaseFor(id, instance).pipe(
            Effect.flatMap((phase) =>
              expectedGeneration !== undefined && instance.revisions.intent !== expectedGeneration
                ? Effect.fail(
                    new StackLifecycleConflictError({
                      stackId: options.stackId,
                      instanceId: id,
                      message: `Idle retirement for service instance ${id} is stale`,
                    }),
                  )
                : phase === "stopped"
                  ? Effect.fail(
                      new StackLifecycleConflictError({
                        stackId: options.stackId,
                        instanceId: id,
                        message: `Service instance ${id} is stopped and cannot be put to sleep`,
                      }),
                    )
                  : Effect.forEach(
                      state.registry.instances.filter(
                        (dependent) =>
                          dependent.intent === "started" &&
                          dependent.id !== id &&
                          Object.values(dependent.dependencies).includes(id),
                      ),
                      (dependent) =>
                        phaseFor(dependent.id, dependent).pipe(
                          Effect.map(
                            (dependentPhase) =>
                              dependentPhase !== "stopped" && dependentPhase !== "dormant",
                          ),
                        ),
                    ).pipe(
                      Effect.map((active) => active.some(Boolean)),
                      Effect.flatMap((active) =>
                        active
                          ? Effect.fail(
                              new StackLifecycleConflictError({
                                stackId: options.stackId,
                                instanceId: id,
                                message: `Service instance ${id} has active dependents`,
                              }),
                            )
                          : (
                              options.isInstanceWakeable?.(instance.id) ?? Effect.succeed(true)
                            ).pipe(
                              Effect.flatMap((wakeable) =>
                                wakeable
                                  ? Effect.void
                                  : Effect.fail(
                                      new StackLifecycleConflictError({
                                        stackId: options.stackId,
                                        instanceId: id,
                                        message: `Service instance ${id} has no demand-wake route`,
                                      }),
                                    ),
                              ),
                            ),
                      ),
                    ),
            ),
          ),
        batchToken,
        () => status(id),
        undefined,
        fromIdle,
      ).pipe(Effect.andThen(status(id)));
    yield* Ref.set(sleepRef, (id, generation) =>
      sleep(id, undefined, generation, true).pipe(Effect.asVoid),
    );
    const destroy = (id: ServiceInstanceId, batchToken?: symbol) =>
      run(
        id,
        "destroy",
        (input) =>
          (input.plan.workloads.some((workload) => workload.instanceId === id)
            ? options.runtime.destroy(input)
            : Effect.void
          ).pipe(Effect.andThen(unpublishBindings(input.instance.id))),
        (state, instance) =>
          removeServiceInstance(state.registry, instance.id).pipe(
            Effect.map((registry) => ({
              ...state,
              registry,
              ports: state.ports.filter(
                (assignment) =>
                  assignment.owner !== "instance" || assignment.instanceId !== instance.id,
              ),
              privatePorts: state.privatePorts.filter(
                (assignment) => assignment.instanceId !== instance.id,
              ),
            })),
            Effect.mapError((error) => new StackStateInvalidError({ message: error.message })),
          ),
        undefined,
        undefined,
        ({ state, instance }) => {
          const dependent = state.registry.instances.find((entry) =>
            Object.values(entry.dependencies).includes(instance.id),
          );
          return dependent === undefined
            ? Effect.void
            : Effect.fail(
                new StackLifecycleConflictError({
                  stackId: options.stackId,
                  instanceId: instance.id,
                  message: `Service instance ${instance.id} has dependent ${dependent.id}`,
                }),
              );
        },
        batchToken,
      ).pipe(
        Effect.andThen(PubSub.publish(statusUpdates, { id, destroyed: true })),
        Effect.andThen(options.publishStatus ?? Effect.void),
        Effect.asVoid,
      );
    const prepare = (id: ServiceInstanceId) =>
      current(id).pipe(
        Effect.flatMap(({ state, instance }) =>
          instancePlan(state, id).pipe(
            Effect.flatMap((plan) =>
              Context.get(options.context, Crypto.Crypto).randomUUIDv4.pipe(
                Effect.mapError(
                  (error) =>
                    new StackStateInvalidError({
                      stackId: options.stackId,
                      message: `Unable to allocate operation identity: ${error.message}`,
                      cause: error,
                    }),
                ),
                Effect.flatMap((operationId) =>
                  Effect.forkIn(
                    options.runtime.prepare({
                      stackId: options.stackId,
                      state,
                      instance,
                      plan,
                      operation: { id: operationId, generation: 0 },
                    }),
                    options.scope,
                    { startImmediately: true },
                  ),
                ),
                Effect.flatMap(Fiber.join),
                Effect.flatMap((result) =>
                  fingerprintEffectiveConfig(instance, state.security, state.secrets).pipe(
                    Effect.provideService(
                      Crypto.Crypto,
                      Context.get(options.context, Crypto.Crypto),
                    ),
                    Effect.mapError(
                      (error) =>
                        new StackStateInvalidError({
                          stackId: options.stackId,
                          message: "Unable to fingerprint prepared service configuration",
                          cause: error,
                        }),
                    ),
                    Effect.map((effectiveConfigFingerprint) => ({
                      ...result,
                      instances: result.instances.map((entry) =>
                        entry.id === instance.id
                          ? {
                              ...entry,
                              ...(effectiveConfigFingerprint === undefined
                                ? {}
                                : { effectiveConfigFingerprint }),
                            }
                          : entry,
                      ),
                    })),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    type RestartPhaseSchedule = {
      readonly candidates: ReadonlyArray<InstanceRestartCandidate>;
      readonly stopped: ReadonlyMap<
        ServiceInstanceId,
        Deferred.Deferred<Exit.Exit<void, StackError>, never>
      >;
      readonly ready: ReadonlyMap<
        ServiceInstanceId,
        Deferred.Deferred<Exit.Exit<void, StackError>, never>
      >;
    };
    const awaitPhase = (
      completions: ReadonlyMap<
        ServiceInstanceId,
        Deferred.Deferred<Exit.Exit<void, StackError>, never>
      >,
      ids: ReadonlyArray<ServiceInstanceId>,
    ): Effect.Effect<void, StackError> =>
      Effect.forEach(
        ids,
        (dependency) => {
          const completion = completions.get(dependency);
          return completion === undefined
            ? Effect.void
            : Deferred.await(completion).pipe(
                Effect.flatMap((exit) => joinStartExit(dependency, exit)),
              );
        },
        { discard: true },
      );
    const restartOperation = (
      id: ServiceInstanceId,
      replacement: InstanceRestartCandidate | undefined,
      batchToken?: symbol,
      schedule?: RestartPhaseSchedule,
    ) =>
      run(
        id,
        "restart",
        (input) =>
          Effect.gen(function* () {
            const previousInput =
              replacement === undefined
                ? input
                : {
                    ...input,
                    state: replacement.previous.state,
                    instance: replacement.previous.instance,
                    plan: yield* instancePlan(replacement.previous.state, id),
                  };
            const newDependencies =
              replacement === undefined ? [] : Object.values(input.instance.dependencies);
            const dependents =
              schedule === undefined
                ? []
                : schedule.candidates
                    .filter((candidate) =>
                      Object.values(candidate.previous.instance.dependencies).includes(id),
                    )
                    .map((candidate) => candidate.instance.id);
            const stopped = yield* Effect.exit(
              (schedule === undefined
                ? Effect.void
                : awaitPhase(schedule.stopped, dependents)
              ).pipe(
                Effect.andThen(
                  options.runtime.stop(previousInput).pipe(
                    Effect.mapError(
                      (error) =>
                        new StackCleanupError({
                          message: `Restart teardown failed and cleanup was not proven: ${error.message}`,
                          cause: error,
                        }),
                    ),
                  ),
                ),
                Effect.andThen(unpublishBindings(input.instance.id)),
              ),
            );
            const stoppedCompletion = schedule?.stopped.get(id);
            if (stoppedCompletion !== undefined)
              yield* Deferred.succeed(stoppedCompletion, stopped);
            if (!Exit.isSuccess(stopped)) {
              const readyCompletion = schedule?.ready.get(id);
              if (readyCompletion !== undefined) yield* Deferred.succeed(readyCompletion, stopped);
              return yield* joinExit(stopped);
            }
            const startImmediately = replacement?.startImmediately !== false;
            const started = yield* Effect.exit(
              (schedule === undefined
                ? Effect.void
                : awaitPhase(
                    schedule.ready,
                    newDependencies.filter((dependency) => schedule.ready.has(dependency)),
                  )
              ).pipe(
                Effect.andThen(
                  startImmediately
                    ? withDependencyTraffic(input, startAndPublish(input))
                    : Effect.succeed([] as ReadonlyArray<RuntimeBindingPublication>),
                ),
              ),
            );
            const readyCompletion = schedule?.ready.get(id);
            if (readyCompletion !== undefined) {
              const readyExit = Exit.isSuccess(started)
                ? Exit.succeed(undefined)
                : Exit.failCause(started.cause);
              yield* Deferred.succeed(readyCompletion, readyExit);
            }
            yield* joinExit(started);
          }),
        (state, instance) =>
          Effect.succeed({
            ...state,
            registry: {
              ...state.registry,
              instances: state.registry.instances.map((entry) =>
                entry.id === instance.id
                  ? {
                      ...entry,
                      intent: replacement?.desiredIntent ?? ("started" as const),
                      pendingOperation: null,
                    }
                  : entry,
              ),
            },
          }),
        undefined,
        undefined,
        ({ state, instance }) =>
          state.registry.instances.some(
            (dependent) =>
              dependent.intent === "started" &&
              batchToken === undefined &&
              Object.values(dependent.dependencies).includes(instance.id),
          )
            ? Effect.fail(
                new StackLifecycleConflictError({
                  stackId: options.stackId,
                  instanceId: id,
                  message: `Service instance ${id} has active dependents`,
                }),
              )
            : Effect.void,
        batchToken,
        undefined,
        replacement,
      ).pipe(Effect.andThen(status(id)));
    const restart = (id: ServiceInstanceId, replacement?: InstanceRestartCandidate) =>
      restartOperation(id, replacement);
    const requireSnapshotSupport = (id: ServiceInstanceId) =>
      current(id).pipe(
        Effect.flatMap(({ instance }) =>
          instance.service === "database"
            ? Effect.void
            : Effect.fail(
                new UnsupportedSnapshotError({
                  instanceId: id,
                  service: instance.service,
                  message: `Service instance ${id} does not support snapshots`,
                }),
              ),
        ),
      );
    const exportSnapshot = (id: ServiceInstanceId, destination: string) =>
      requireSnapshotSupport(id).pipe(
        Effect.andThen(
          run(
            id,
            "exportSnapshot",
            (input) => options.runtime.exportSnapshot(input, { destination }),
            (state, instance) =>
              Effect.succeed({
                ...state,
                registry: {
                  ...state.registry,
                  instances: state.registry.instances.map((entry) =>
                    entry.id === instance.id ? { ...entry, pendingOperation: null } : entry,
                  ),
                },
              }),
          ),
        ),
      );
    const restoreSnapshot = (id: ServiceInstanceId, source: string) =>
      requireSnapshotSupport(id).pipe(
        Effect.andThen(
          run(
            id,
            "restoreSnapshot",
            (input) => options.runtime.restoreSnapshot(input, { source }),
            (state, instance, value) =>
              Effect.succeed({
                ...state,
                registry: {
                  ...state.registry,
                  instances: state.registry.instances.map((entry) =>
                    entry.id === instance.id
                      ? {
                          ...entry,
                          pendingOperation: null,
                          data: { origin: "restored" as const, snapshot: value },
                        }
                      : entry,
                  ),
                },
              }),
          ),
        ),
      );
    const recover: Effect.Effect<void, StackError> = read().pipe(
      Effect.flatMap((state) =>
        Effect.forEach(
          state.registry.instances.filter((instance) => instance.pendingOperation !== null),
          (instance) =>
            Effect.gen(function* () {
              const pending = instance.pendingOperation;
              if (pending === null) return;
              if (pending.kind === "exportSnapshot" || pending.kind === "restoreSnapshot") {
                const recovered: Effect.Effect<SnapshotDescriptor | undefined, StackError> =
                  options.runtime.recoverSnapshot === undefined
                    ? Effect.fail(
                        new StackLifecycleConflictError({
                          stackId: options.stackId,
                          instanceId: instance.id,
                          message: `Snapshot operation ${pending.id} has no recovery evidence reader`,
                        }),
                      )
                    : options.runtime
                        .recoverSnapshot(
                          {
                            stackId: options.stackId,
                            state,
                            instance,
                            plan: yield* instancePlan(state, instance.id),
                            operation: { id: pending.id, generation: pending.generation },
                          },
                          pending,
                        )
                        .pipe(
                          Effect.flatMap((snapshot) =>
                            pending.phase === "complete" &&
                            pending.kind === "restoreSnapshot" &&
                            snapshot === undefined
                              ? Effect.fail(
                                  new StackLifecycleConflictError({
                                    stackId: options.stackId,
                                    instanceId: instance.id,
                                    message: `Restore operation ${pending.id} has no committed snapshot manifest`,
                                  }),
                                )
                              : Effect.succeed(snapshot),
                          ),
                        );
                yield* recovered.pipe(
                  Effect.flatMap((snapshot) =>
                    options.stateStore.update<StackError>(options.stackId, (current) => {
                      const currentInstance = current.registry.instances.find(
                        (entry) => entry.id === instance.id,
                      );
                      return currentInstance?.pendingOperation?.id === pending.id &&
                        currentInstance.pendingOperation.generation === pending.generation
                        ? Effect.succeed({
                            ...current,
                            registry: {
                              ...current.registry,
                              instances: current.registry.instances.map((entry) =>
                                entry.id === instance.id
                                  ? {
                                      ...entry,
                                      pendingOperation: null,
                                      ...(snapshot === undefined
                                        ? pending.kind === "restoreSnapshot"
                                          ? { data: { origin: "absent" as const } }
                                          : {}
                                        : { data: { origin: "restored" as const, snapshot } }),
                                    }
                                  : entry,
                              ),
                            },
                          })
                        : Effect.fail(
                            new StackLifecycleConflictError({
                              stackId: options.stackId,
                              instanceId: instance.id,
                              message: `Recovery operation ${pending.id} was superseded`,
                            }),
                          );
                    }),
                  ),
                  Effect.provideContext(options.context),
                  Effect.asVoid,
                );
                return;
              }
              const plan = yield* instancePlan(state, instance.id);
              const input: InstanceRuntimeInput = {
                stackId: options.stackId,
                state,
                instance,
                plan,
                operation: { id: pending.id, generation: pending.generation },
              };
              if (pending.kind === "destroy") yield* options.runtime.destroy(input);
              else yield* options.runtime.stop(input);
              yield* options.stateStore
                .update<StackError>(options.stackId, (current) => {
                  const currentInstance = current.registry.instances.find(
                    (entry) => entry.id === instance.id,
                  );
                  if (
                    currentInstance === undefined ||
                    currentInstance.pendingOperation?.id !== pending.id ||
                    currentInstance.pendingOperation.generation !== pending.generation
                  )
                    return Effect.fail(
                      new StackLifecycleConflictError({
                        stackId: options.stackId,
                        instanceId: instance.id,
                        message: `Recovery operation ${pending.id} was superseded`,
                      }),
                    );
                  if (pending.kind === "destroy")
                    return removeServiceInstance(current.registry, instance.id).pipe(
                      Effect.map((registry) => ({
                        ...current,
                        registry,
                        ports: current.ports.filter(
                          (assignment) =>
                            assignment.owner !== "instance" ||
                            assignment.instanceId !== instance.id,
                        ),
                        privatePorts: current.privatePorts.filter(
                          (assignment) => assignment.instanceId !== instance.id,
                        ),
                      })),
                      Effect.mapError(
                        (error) =>
                          new StackStateInvalidError({
                            stackId: options.stackId,
                            message: error.message,
                            cause: error,
                          }),
                      ),
                    );
                  return Effect.succeed({
                    ...current,
                    registry: {
                      ...current.registry,
                      instances: current.registry.instances.map((entry) =>
                        entry.id === instance.id ? { ...entry, pendingOperation: null } : entry,
                      ),
                    },
                  });
                })
                .pipe(Effect.provideContext(options.context), Effect.asVoid);
            }).pipe(
              Effect.catch((error) => {
                const pending = instance.pendingOperation;
                return pending === null ? Effect.void : markRecovery(instance.id, pending, error);
              }),
            ),
          { discard: true },
        ),
      ),
    );
    const selectedIds = (
      mutation: Mutation,
      requested: ReadonlyArray<ServiceInstanceId> | undefined,
    ): Effect.Effect<ReadonlyArray<ServiceInstanceId>, ServiceNotFoundError | StackError> =>
      requested !== undefined && requested.length === 0
        ? Effect.succeed([])
        : read().pipe(
            Effect.flatMap(
              (
                state,
              ): Effect.Effect<
                ReadonlyArray<ServiceInstanceId>,
                ServiceNotFoundError | StackError
              > =>
                Effect.gen(function* () {
                  const recoveries = yield* Ref.get(recovery);
                  const ids = [
                    ...new Set(
                      requested ??
                        state.registry.instances
                          .filter((instance) =>
                            mutation === "destroy"
                              ? true
                              : mutation === "start"
                                ? instance.config.enabled && instance.config.activation === "eager"
                                : mutation === "stop"
                                  ? true
                                  : instance.intent === "started",
                          )
                          .map((instance) => instance.id),
                    ),
                  ];
                  for (const id of ids)
                    if (!state.registry.instances.some((entry) => entry.id === id))
                      return yield* notFound(id);
                  for (const id of ids) {
                    const instance = state.registry.instances.find((entry) => entry.id === id);
                    const pending = instance?.pendingOperation;
                    const canSupersede =
                      (mutation === "stop" || mutation === "destroy") &&
                      (pending?.kind === "start" ||
                        pending?.kind === "restart" ||
                        (instance !== undefined && recoveries.has(instance.id)));
                    const canJoinStart = mutation === "start" && pending?.kind === "start";
                    if (pending !== null && pending !== undefined && !canSupersede && !canJoinStart)
                      return yield* new StackLifecycleConflictError({
                        stackId: options.stackId,
                        message: `Service instance ${id} already has a pending operation`,
                      });
                    if (
                      (mutation === "start" || mutation === "restart") &&
                      instance !== undefined &&
                      !instance.config.enabled
                    )
                      return yield* new StackLifecycleConflictError({
                        stackId: options.stackId,
                        instanceId: id,
                        message: `Disabled service instance ${id} cannot be started`,
                      });
                  }
                  if (mutation === "sleep") {
                    const selected = new Set(ids);
                    for (const id of ids) {
                      const activeDependent = yield* Effect.forEach(
                        state.registry.instances.filter(
                          (dependent) =>
                            dependent.intent === "started" &&
                            !selected.has(dependent.id) &&
                            Object.values(dependent.dependencies).includes(id),
                        ),
                        (dependent) =>
                          phaseFor(dependent.id, dependent).pipe(
                            Effect.map(
                              (dependentPhase) =>
                                dependentPhase !== "stopped" && dependentPhase !== "dormant",
                            ),
                          ),
                      ).pipe(Effect.map((active) => active.some(Boolean)));
                      if (activeDependent)
                        return yield* new StackLifecycleConflictError({
                          stackId: options.stackId,
                          instanceId: id,
                          message: `Service instance ${id} has active dependents`,
                        });
                      const active = yield* options.isInstanceActive?.(id) ?? Effect.succeed(false);
                      if (active)
                        return yield* new StackLifecycleConflictError({
                          stackId: options.stackId,
                          instanceId: id,
                          message: `Service instance ${id} has active traffic and cannot sleep`,
                        });
                      const wakeable = yield* (
                        options.isInstanceWakeable?.(id) ?? Effect.succeed(true)
                      );
                      if (!wakeable)
                        return yield* new StackLifecycleConflictError({
                          stackId: options.stackId,
                          instanceId: id,
                          message: `Service instance ${id} has no demand-wake route`,
                        });
                    }
                  }
                  if (mutation === "stop" || mutation === "restart") {
                    const selected = new Set(ids);
                    for (const id of ids) {
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
                  }
                  if (mutation === "destroy") {
                    const selected = new Set(ids);
                    for (const id of ids) {
                      const dependent = state.registry.instances.find(
                        (entry) =>
                          !selected.has(entry.id) && Object.values(entry.dependencies).includes(id),
                      );
                      if (dependent !== undefined)
                        return yield* new StackLifecycleConflictError({
                          stackId: options.stackId,
                          instanceId: id,
                          message: `Service instance ${id} has dependent ${dependent.id}`,
                        });
                    }
                  }
                  if (ids.length === 0) return ids;
                  return yield* createExecutionPlan(
                    state.runtime,
                    state.registry,
                    undefined,
                    new Set(ids),
                  ).pipe(
                    Effect.mapError(
                      (error) =>
                        new StackStateInvalidError({ message: error.message, cause: error }),
                    ),
                    Effect.as(ids),
                  );
                }),
            ),
          );
    const orderedIds = (
      ids: ReadonlyArray<ServiceInstanceId>,
      reverse: boolean,
    ): Effect.Effect<ReadonlyArray<ServiceInstanceId>, StackError> =>
      read().pipe(
        Effect.flatMap((state) =>
          createExecutionPlan(state.runtime, state.registry, undefined, new Set(ids)).pipe(
            Effect.map((plan) => {
              const selected = new Set(ids);
              const ordered = plan.startOrder.filter((id) => selected.has(id));
              return reverse ? [...ordered].reverse() : ordered;
            }),
            Effect.mapError(
              (error) => new StackStateInvalidError({ message: error.message, cause: error }),
            ),
          ),
        ),
      );
    const runBatch = <A>(
      ids: ReadonlyArray<ServiceInstanceId>,
      mutation: Mutation,
      operation: (token: symbol) => Effect.Effect<A, ServiceNotFoundError | StackError>,
      rejectActive = false,
      startupControlAllowed = false,
      allowPendingStarts = false,
      allowRecoveryCleanup = false,
    ): Effect.Effect<A, ServiceNotFoundError | StackError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const token = yield* restore(
            claimBatch(
              ids,
              mutation,
              rejectActive,
              startupControlAllowed,
              allowRecoveryCleanup,
              allowPendingStarts,
            ),
          );
          const owner = operation(token).pipe(
            Effect.onExit((exit) =>
              Ref.get(batchClaims).pipe(
                Effect.flatMap((claims) =>
                  Effect.forEach(ids, (id) => {
                    const completion = claims.get(id);
                    return completion?.token === token && completion.completion !== undefined
                      ? Deferred.succeed(completion.completion, voidExit(exit)).pipe(Effect.asVoid)
                      : Effect.void;
                  }),
                ),
                Effect.andThen(releaseBatch(ids, token)),
              ),
            ),
          );
          const fiber = yield* Effect.forkIn(restore(owner), options.scope, {
            startImmediately: true,
          });
          return yield* restore(Fiber.join(fiber));
        }),
      );
    const collectStatuses = (
      requested: ReadonlyArray<ServiceInstanceId>,
      affected: ReadonlyArray<ServiceInstanceId>,
      operation: (
        id: ServiceInstanceId,
      ) => Effect.Effect<ServiceStatus, ServiceNotFoundError | StackError>,
      concurrent = false,
    ): Effect.Effect<ReadonlyArray<ServiceStatus>, ServiceNotFoundError | StackError> =>
      Effect.forEach(
        affected,
        (id) => Effect.exit(operation(id)),
        concurrent ? { concurrency: "unbounded" as const } : undefined,
      ).pipe(
        Effect.flatMap((outcomes) => {
          const completed = outcomes.map(Exit.isSuccess);
          const values = outcomes.flatMap((outcome) =>
            Exit.isSuccess(outcome) ? [outcome.value] : [],
          );
          const failure = outcomes.find((outcome) => Exit.isFailure(outcome));
          if (failure === undefined || !Exit.isFailure(failure)) return Effect.succeed(values);
          const error = errorFromCause(failure.cause);
          return Effect.fail(
            error instanceof ServiceNotFoundError
              ? error
              : new StackLifecycleConflictError({
                  stackId: options.stackId,
                  ...(error instanceof StackLifecycleConflictError && error.instanceId !== undefined
                    ? { instanceId: error.instanceId }
                    : {}),
                  message: error.message,
                  cause: error,
                  outcome: { ...outcomeFor(requested, affected, completed), statuses: values },
                }),
          );
        }),
      );
    const restartAll = (
      candidates: ReadonlyArray<InstanceRestartCandidate>,
      shared?: RestartSharedPatch,
    ): Effect.Effect<ReadonlyArray<ServiceStatus>, ServiceNotFoundError | StackError> => {
      const ids: ReadonlyArray<ServiceInstanceId> = candidates.map(
        (candidate) => candidate.instance.id,
      );
      if (new Set(ids).size !== ids.length)
        return Effect.fail<StackError>(
          new StackLifecycleConflictError({
            stackId: options.stackId,
            message: "A restart batch cannot contain duplicate service instances",
          }),
        );
      const work = runBatch(
        ids,
        "restart",
        (batchToken) =>
          Effect.gen(function* () {
            const operationIds = yield* Effect.forEach(candidates, () =>
              Context.get(options.context, Crypto.Crypto).randomUUIDv4.pipe(
                Effect.mapError(
                  (error) =>
                    new StackStateInvalidError({
                      stackId: options.stackId,
                      message: `Unable to allocate operation identity: ${error.message}`,
                      cause: error,
                    }),
                ),
              ),
            );
            const committed = yield* metadataAdmission.withPermit(
              options.stateStore
                .update<StackError>(
                  options.stackId,
                  (state): Effect.Effect<PersistedStackState, StackError> =>
                    Effect.gen(function* () {
                      const claims = yield* Ref.get(batchClaims);
                      const selected = new Set(ids);
                      for (const candidate of candidates) {
                        const blockedDependency = Object.values(
                          candidate.instance.dependencies,
                        ).find((dependencyId) => {
                          const claim = claims.get(dependencyId);
                          return (
                            !selected.has(dependencyId) &&
                            claim?.mutation !== undefined &&
                            claim.mutation !== "start" &&
                            claim.token !== batchToken
                          );
                        });
                        if (blockedDependency !== undefined)
                          return yield* new StackLifecycleConflictError({
                            stackId: options.stackId,
                            instanceId: blockedDependency,
                            message: `Dependency ${blockedDependency} is changing lifecycle state`,
                          });
                      }
                      const currentInstances = candidates.map((candidate) =>
                        state.registry.instances.find(
                          (entry) => entry.id === candidate.instance.id,
                        ),
                      );
                      for (const [index, candidate] of candidates.entries()) {
                        const current = currentInstances[index];
                        if (current === undefined) return yield* notFound(candidate.instance.id);
                        if (
                          current.pendingOperation !== null ||
                          current.service !== candidate.instance.service ||
                          current.revisions.config !==
                            candidate.previous.instance.revisions.config ||
                          current.revisions.intent !== candidate.previous.instance.revisions.intent
                        )
                          return yield* new StackLifecycleConflictError({
                            stackId: options.stackId,
                            instanceId: candidate.instance.id,
                            message: `Service instance ${candidate.instance.id} changed before its restart batch was admitted`,
                          });
                      }
                      const replacements = yield* Effect.forEach(
                        candidates,
                        (
                          candidate,
                          index,
                        ): Effect.Effect<
                          PersistedServiceInstance,
                          ServiceNotFoundError | StackError
                        > => {
                          const current = currentInstances[index];
                          if (current === undefined)
                            return Effect.fail(notFound(candidate.instance.id));
                          const operationId = operationIds[index];
                          if (operationId === undefined)
                            return Effect.fail(
                              new StackStateInvalidError({
                                stackId: options.stackId,
                                message: `Restart batch operation identity is missing for ${candidate.instance.id}`,
                              }),
                            );
                          return Schema.decodeUnknownEffect(PersistedServiceInstanceSchema)({
                            ...candidate.instance,
                            id: current.id,
                            service: current.service,
                            intent: candidate.desiredIntent ?? ("started" as const),
                            resources: current.resources,
                            data: current.data,
                            revisions: {
                              ...current.revisions,
                              config: current.revisions.config + 1,
                              intent: current.revisions.intent + 1,
                            },
                            pendingOperation: {
                              id: operationId,
                              kind: "restart" as const,
                              generation: current.revisions.intent + 1,
                              ownerSessionId: options.ownerSessionId,
                              phase: "running" as const,
                            },
                          }).pipe(
                            Effect.mapError(
                              (error) =>
                                new StackStateInvalidError({
                                  stackId: options.stackId,
                                  message: `Restarted service instance failed validation: ${String(error)}`,
                                  cause: error,
                                }),
                            ),
                          );
                        },
                      );
                      const replacedIds = new Set<string>(ids);
                      const replacementsById = new Map(
                        replacements.map((replacement) => [replacement.id, replacement]),
                      );
                      const changedBindingsById = new Map<string, ReadonlySet<string>>(
                        candidates.map((candidate) => [
                          candidate.instance.id,
                          changedEndpointBindings(
                            candidate.previous.instance.config.endpoints,
                            candidate.instance.config.endpoints,
                          ),
                        ]),
                      );
                      const registry = {
                        ...state.registry,
                        instances: state.registry.instances.map((entry) => {
                          return replacementsById.get(entry.id) ?? entry;
                        }),
                      };
                      const secretSlotMap = new Map<string, SecretSlotInput>();
                      for (const secretSlot of [
                        ...(shared?.secretSlots ?? []),
                        ...candidates.flatMap((candidate) => candidate.secretSlots),
                      ])
                        secretSlotMap.set(secretSlot.slot, secretSlot);
                      const secretSlots = [...secretSlotMap.values()];
                      const slotIds = new Set(secretSlots.map((slot) => slot.slot));
                      const declarations = [
                        ...Object.entries(state.secrets)
                          .filter(([slot]) => !slotIds.has(slot))
                          .map(([slot, entry]) => ({
                            slot,
                            policy: entry.policy,
                            value: Redacted.make(entry.value),
                          })),
                        ...secretSlots,
                      ];
                      const resolved = yield* resolveSecrets(
                        { declarations },
                        Object.fromEntries(
                          Object.entries(state.secrets).filter(([slot]) => !slotIds.has(slot)),
                        ),
                        "stopped",
                      ).pipe(Effect.provideContext(options.context));
                      let nextState: PersistedStackState = {
                        ...state,
                        ...(shared?.preparation === undefined
                          ? {}
                          : { preparation: shared.preparation }),
                        ...(shared?.security === undefined ? {} : { security: shared.security }),
                        ...(shared?.listeners === undefined ? {} : { listeners: shared.listeners }),
                        registry,
                        secrets: resolved.persisted,
                        ports: (shared?.ports ?? state.ports).filter((assignment) => {
                          if (assignment.owner !== "instance") return true;
                          if (!replacedIds.has(assignment.instanceId)) return true;
                          return !changedBindingsById
                            .get(assignment.instanceId)
                            ?.has(assignment.binding);
                        }),
                        privatePorts: state.privatePorts,
                      };
                      for (const replacement of replacements) {
                        const ports = yield* plannedInstancePorts(nextState, replacement);
                        nextState = { ...nextState, ...ports };
                      }
                      return nextState;
                    }),
                )
                .pipe(
                  Effect.provideContext(options.context),
                  Effect.mapError((error) =>
                    error instanceof ServiceNotFoundError || isStackError(error)
                      ? error
                      : new StackStateInvalidError({
                          stackId: options.stackId,
                          message: String(error),
                          cause: error,
                        }),
                  ),
                ),
            );
            const admitted = yield* Effect.forEach(
              candidates,
              (
                candidate,
                index,
              ): Effect.Effect<InstanceRestartCandidate, StackError | ServiceNotFoundError> => {
                const current = committed.registry.instances.find(
                  (entry) => entry.id === candidate.instance.id,
                );
                const pending = current?.pendingOperation;
                const operationId = operationIds[index];
                if (
                  current === undefined ||
                  pending === null ||
                  pending === undefined ||
                  operationId === undefined ||
                  pending.id !== operationId ||
                  pending.generation !== current.revisions.intent
                )
                  return Effect.fail(
                    new StackLifecycleConflictError({
                      stackId: options.stackId,
                      instanceId: candidate.instance.id,
                      message: `Service instance ${candidate.instance.id} lost its restart admission`,
                    }),
                  );
                return Effect.succeed({
                  ...candidate,
                  admission: { operationId, generation: pending.generation },
                });
              },
            );
            const stopped = new Map<
              ServiceInstanceId,
              Deferred.Deferred<Exit.Exit<void, StackError>, never>
            >();
            const ready = new Map<
              ServiceInstanceId,
              Deferred.Deferred<Exit.Exit<void, StackError>, never>
            >();
            for (const candidate of admitted) {
              stopped.set(
                candidate.instance.id,
                yield* Deferred.make<Exit.Exit<void, StackError>>(),
              );
              ready.set(candidate.instance.id, yield* Deferred.make<Exit.Exit<void, StackError>>());
            }
            const schedule: RestartPhaseSchedule = { candidates: admitted, stopped, ready };
            const restartOne = (candidate: InstanceRestartCandidate) => {
              const id = candidate.instance.id;
              const complete = (
                exit: Exit.Exit<unknown, ServiceNotFoundError | StackError>,
                completion: Deferred.Deferred<Exit.Exit<void, StackError>, never> | undefined,
              ) =>
                completion === undefined
                  ? Effect.void
                  : Deferred.succeed(completion, voidExit(exit)).pipe(Effect.asVoid);
              return restartOperation(id, candidate, batchToken, schedule).pipe(
                Effect.onExit((exit) =>
                  complete(exit, stopped.get(id)).pipe(
                    Effect.andThen(complete(exit, ready.get(id))),
                  ),
                ),
              );
            };
            const outcomes = yield* Effect.forEach(
              admitted,
              (candidate) => Effect.exit(restartOne(candidate)),
              { concurrency: "unbounded" },
            );
            const values: ServiceStatus[] = [];
            const completed = outcomes.map(Exit.isSuccess);
            for (const outcome of outcomes) if (Exit.isSuccess(outcome)) values.push(outcome.value);
            const failure = outcomes.find((outcome) => Exit.isFailure(outcome));
            if (failure !== undefined && Exit.isFailure(failure)) {
              const error = errorFromCause(failure.cause);
              return yield* new StackLifecycleConflictError({
                stackId: options.stackId,
                ...(error instanceof StackLifecycleConflictError && error.instanceId !== undefined
                  ? { instanceId: error.instanceId }
                  : {}),
                message: error.message,
                cause: error,
                outcome: outcomeFor(ids, ids, completed),
              });
            }
            return values;
          }),
        false,
        true,
      );
      // Once the batch journal is committed, its owner continues independently of the request
      // waiter. This prevents cancellation between candidates from stranding admitted journals.
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(work, options.scope, { startImmediately: true });
          return yield* restore(Fiber.join(fiber));
        }),
      );
    };
    const startAll = (requested?: ReadonlyArray<ServiceInstanceId>) => {
      const startSelected = selectedIds("start", requested).pipe(
        Effect.flatMap((ids) =>
          runBatch(
            ids,
            "start",
            (token) =>
              orderedIds(ids, false).pipe(
                Effect.flatMap((ordered) =>
                  collectStatuses(ids, ordered, (id) => startOperation(id, token), true),
                ),
              ),
            false,
            true,
            true,
          ),
        ),
      );
      if (requested !== undefined) return startSelected;
      const markLazyStarted = read().pipe(
        Effect.flatMap((state) => {
          const lazyIds = state.registry.instances
            .filter(
              (instance) =>
                instance.config.enabled &&
                instance.config.activation === "lazy" &&
                instance.intent === "stopped" &&
                instance.pendingOperation === null,
            )
            .map((instance) => instance.id);
          return metadataAdmission
            .withPermit(
              options.stateStore.update(options.stackId, (current) =>
                Effect.gen(function* () {
                  const claims = yield* Ref.get(batchClaims);
                  for (const id of lazyIds) {
                    const instance = current.registry.instances.find((entry) => entry.id === id);
                    const blockedDependency =
                      instance === undefined
                        ? undefined
                        : Object.values(instance.dependencies).find((dependencyId) => {
                            const claim = claims.get(dependencyId);
                            return claim?.mutation !== undefined && claim.mutation !== "start";
                          });
                    if (blockedDependency !== undefined)
                      return yield* new StackLifecycleConflictError({
                        stackId: options.stackId,
                        instanceId: blockedDependency,
                        message: `Dependency ${blockedDependency} is changing lifecycle state`,
                      });
                  }
                  const withStartedIntents = {
                    ...current,
                    registry: {
                      ...current.registry,
                      instances: current.registry.instances.map((instance) =>
                        lazyIds.includes(instance.id) &&
                        instance.intent === "stopped" &&
                        instance.pendingOperation === null &&
                        instance.config.activation === "lazy"
                          ? { ...instance, intent: "started" as const }
                          : instance,
                      ),
                    },
                  };
                  let planned = withStartedIntents;
                  for (const instance of planned.registry.instances.filter(
                    (entry) =>
                      entry.config.enabled &&
                      entry.config.activation === "lazy" &&
                      entry.intent === "started" &&
                      entry.pendingOperation === null,
                  )) {
                    const ports = yield* plannedInstancePorts(planned, instance);
                    planned = { ...planned, ...ports };
                  }
                  return planned;
                }),
              ),
            )
            .pipe(
              Effect.provideContext(options.context),
              Effect.flatMap((updated) =>
                Effect.gen(function* () {
                  if (options.armLazyIngress !== undefined) {
                    const plan = yield* createExecutionPlan(updated.runtime, updated.registry).pipe(
                      Effect.mapError(
                        (error) =>
                          new StackStateInvalidError({
                            stackId: options.stackId,
                            message: error.message,
                            cause: error,
                          }),
                      ),
                    );
                    yield* options.armLazyIngress(updated, plan);
                  }
                  yield* Effect.forEach(
                    lazyIds.filter((id) =>
                      updated.registry.instances.some(
                        (instance) =>
                          instance.id === id &&
                          instance.intent === "started" &&
                          instance.pendingOperation === null &&
                          instance.config.activation === "lazy",
                      ),
                    ),
                    (id) => setPhase(id, "dormant"),
                    { discard: true },
                  );
                }),
              ),
            );
        }),
      );
      return startSelected.pipe(
        Effect.flatMap((statuses) => markLazyStarted.pipe(Effect.map(() => statuses))),
      );
    };
    const sleepAll = (requested?: ReadonlyArray<ServiceInstanceId>) =>
      selectedIds("sleep", requested).pipe(
        Effect.flatMap((ids) =>
          runBatch(
            ids,
            "sleep",
            (token) =>
              orderedIds(ids, true).pipe(
                Effect.flatMap((ordered) =>
                  collectStatuses(ids, ordered, (id) => sleep(id, token)),
                ),
              ),
            true,
            false,
            false,
            false,
          ),
        ),
      );
    const stopAll = (requested?: ReadonlyArray<ServiceInstanceId>) =>
      selectedIds("stop", requested).pipe(
        Effect.flatMap((ids) =>
          runBatch(
            ids,
            "stop",
            (token) =>
              orderedIds(ids, true).pipe(
                Effect.flatMap((ordered) => collectStatuses(ids, ordered, (id) => stop(id, token))),
              ),
            false,
            false,
            true,
            true,
          ),
        ),
      );
    const destroyOrder = (
      ids: ReadonlyArray<ServiceInstanceId>,
    ): Effect.Effect<ReadonlyArray<ServiceInstanceId>, StackError> =>
      read().pipe(
        Effect.flatMap((state) =>
          Effect.sync(() => {
            const remaining = new Set(ids);
            const ordered: ServiceInstanceId[] = [];
            while (remaining.size > 0) {
              const candidate = state.registry.instances.find(
                (instance) =>
                  remaining.has(instance.id) &&
                  !state.registry.instances.some(
                    (dependent) =>
                      remaining.has(dependent.id) &&
                      Object.values(dependent.dependencies).includes(instance.id),
                  ),
              );
              if (candidate === undefined)
                return new StackLifecycleConflictError({
                  stackId: options.stackId,
                  message: "Cannot destroy service instances with cyclic dependencies",
                });
              ordered.push(candidate.id);
              remaining.delete(candidate.id);
            }
            return ordered;
          }).pipe(
            Effect.flatMap((value) =>
              value instanceof StackLifecycleConflictError
                ? Effect.fail(value)
                : Effect.succeed(value),
            ),
          ),
        ),
      );
    const destroyAll = (requested?: ReadonlyArray<ServiceInstanceId>) =>
      selectedIds("destroy", requested).pipe(
        Effect.flatMap((ids) =>
          runBatch(
            ids,
            "destroy",
            (token) =>
              destroyOrder(ids).pipe(
                Effect.flatMap((ordered) =>
                  Effect.forEach(ordered, (id) => Effect.exit(destroy(id, token))).pipe(
                    Effect.flatMap((outcomes) => {
                      const completed = outcomes.map(Exit.isSuccess);
                      const failure = outcomes.find((outcome) => Exit.isFailure(outcome));
                      if (failure === undefined || !Exit.isFailure(failure)) return Effect.void;
                      const error = errorFromCause(failure.cause);
                      return read().pipe(
                        Effect.flatMap((state) => {
                          const removed = ids.filter(
                            (id) =>
                              !state.registry.instances.some((instance) => instance.id === id),
                          );
                          const retained = ids.filter((id) =>
                            state.registry.instances.some((instance) => instance.id === id),
                          );
                          return Effect.fail(
                            new StackDestructionError({
                              message: error.message,
                              cause: error,
                              outcome: {
                                ...outcomeFor(ids, ordered, completed),
                                removed,
                                retained,
                              },
                            }),
                          );
                        }),
                      );
                    }),
                  ),
                ),
              ),
            false,
            false,
            true,
            true,
          ),
        ),
      );
    const create = (
      instance: PersistedServiceInstance,
      secretSlots: ReadonlyArray<SecretSlotInput> = [],
    ) =>
      metadataAdmission
        .withPermit(
          options.stateStore
            .update(options.stackId, (state) =>
              Effect.gen(function* () {
                const claims = yield* Ref.get(batchClaims);
                const blockedDependency = Object.values(instance.dependencies).find(
                  (dependencyId) => {
                    const claim = claims.get(dependencyId);
                    return claim?.mutation !== undefined && claim.mutation !== "start";
                  },
                );
                if (blockedDependency !== undefined)
                  return yield* new StackLifecycleConflictError({
                    stackId: options.stackId,
                    instanceId: blockedDependency,
                    message: `Dependency ${blockedDependency} is changing lifecycle state`,
                  });
                const registry = yield* registerServiceInstance(state.registry, instance);
                const newSlots = new Set(secretSlots.map((slot) => slot.slot));
                const declarations = [
                  ...Object.entries(state.secrets)
                    .filter(([slot]) => !newSlots.has(slot))
                    .map(([slot, entry]) => ({
                      slot,
                      policy: entry.policy,
                      value: Redacted.make(entry.value),
                    })),
                  ...secretSlots,
                ];
                const resolved = yield* resolveSecrets(
                  { declarations },
                  state.secrets,
                  "stopped",
                ).pipe(Effect.provideContext(options.context));
                const bootstrapInputsId = yield* fingerprintBootstrapInputs(
                  instance,
                  state.security,
                  resolved.persisted,
                ).pipe(
                  Effect.provideService(Crypto.Crypto, Context.get(options.context, Crypto.Crypto)),
                );
                const materialized =
                  bootstrapInputsId === undefined ? instance : { ...instance, bootstrapInputsId };
                const next = {
                  ...state,
                  registry: {
                    ...registry,
                    instances: registry.instances.map((entry) =>
                      entry.id === materialized.id ? materialized : entry,
                    ),
                  },
                  secrets: resolved.persisted,
                };
                const ports = yield* plannedInstancePorts(next, materialized);
                return { ...next, ...ports };
              }),
            )
            .pipe(
              Effect.provideContext(options.context),
              Effect.mapError((error) =>
                error instanceof ServiceNotFoundError || isStackError(error)
                  ? error
                  : new StackStateInvalidError({
                      stackId: options.stackId,
                      message: error.message,
                      cause: error,
                    }),
              ),
              Effect.flatMap((state) => {
                const created = state.registry.instances.find((entry) => entry.id === instance.id);
                return created === undefined
                  ? Effect.fail(
                      new StackStateInvalidError({
                        stackId: options.stackId,
                        message: `Created service instance ${instance.id} is missing from the registry`,
                      }),
                    )
                  : descriptor(state, created);
              }),
            ),
        )
        .pipe(
          Effect.tap(() =>
            PubSub.publish(statusUpdates, { id: instance.id, destroyed: false }).pipe(
              Effect.andThen(options.publishStatus ?? Effect.void),
            ),
          ),
        );
    return {
      create,
      get,
      describe,
      list,
      status,
      followStatus,
      start,
      acquireTraffic,
      startAll,
      sleepAll,
      stopAll,
      stop,
      sleep,
      destroy,
      destroyAll,
      prepare,
      restart,
      restartAll,
      exportSnapshot,
      restoreSnapshot,
      recover,
    } satisfies InstanceEngine;
  });
