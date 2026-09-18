import {
  Cause,
  Context,
  Crypto,
  Data,
  Effect,
  Exit,
  FileSystem,
  Match,
  Option,
  Path,
  Predicate,
  Redacted,
  Result,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { SocketError } from "effect/unstable/socket/Socket";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
import type { StackIdentity } from "../identity/Identity.ts";
import { resolveStackIdentity, deriveStackId } from "../identity/Identity.ts";
import {
  compileStack,
  fingerprintCreationInputs,
  fingerprintBootstrapInputs,
  fingerprintEffectiveConfig,
  createExecutionPlan,
  canonical,
  resolvedStateValue,
  seedServiceRegistry,
  type SecretSlotInput,
  type SeededServiceRegistry,
  type StackDefinition,
} from "../model/Compiler.ts";
import { makeProductionRuntimeArtifactPreparer } from "../preparation/RuntimeArtifacts.ts";
import { dependencyClosure } from "../model/ExecutionPlan.ts";
import { STACK_STATE_FORMAT, type PersistedStackState } from "../state/StackState.ts";
import {
  PersistedServiceRegistrySchema,
  type PersistedServiceRegistry,
} from "../model/ServiceRegistry.ts";
import { toPersistedIdentity } from "../state/StackState.ts";
import {
  isMissingStateRemnantError,
  makeStackStateStore,
  withRegistryLock,
  type StackStateStore,
} from "../state/StackStateStore.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { AUTH_JWT_SECRET_SLOT, resolveSecrets } from "../state/SecretStore.ts";
import { plannedInstancePorts } from "../supervisor/InstanceEngine.ts";
import { isStackId, StackIdSchema, type StackId } from "./StackId.ts";
import type { StackRuntime, StackRuntimePreference } from "./Runtime.ts";
import type { StackConfig } from "./Config.ts";
import type { ServiceInstanceId } from "./ServiceInstanceId.ts";
import type {
  AnyEffectServiceInstance,
  AnyServiceDescriptor,
  EffectServiceCollection,
  EffectServiceInstance,
  ServiceDescriptor,
  ServiceKind,
  SnapshotDescriptor,
  PrepareResult,
  ServiceCredentials,
} from "./Service.ts";
import {
  EffectCreateServiceOptionsSchema,
  SnapshotDescriptorSchema,
  ServiceRestartPayloadSchema,
} from "./Service.ts";
import {
  type ArtifactPreparationStatus,
  type StackStatus,
  type StackDescriptor,
  type StackInspection,
  type StackRecovery,
} from "./Status.ts";
import type { LogQuery, StackLogBatch, StackLogEntry } from "./Logs.ts";
import type { EffectStackCredentials } from "./Credentials.ts";
import {
  InvalidStackIdentityError,
  InvalidProjectRootError,
  InvalidStackConfigError,
  StackVersionUnsupportedError,
  StackDestructionError,
  StackNotFoundError,
  StackNotRunningError,
  StackOwnershipConflictError,
  OwnerRetiringError,
  UncertainOperationError,
  StackRuntimeMismatchError,
  StackLifecycleConflictError,
  StackPreparationError,
  ArtifactIntegrityError,
  ContainerPullError,
  StackSecretMismatchError,
  InvalidJwtSigningMaterialError,
  StackRuntimeError,
  StackCleanupError,
  ContainerEngineError,
  StackStateInvalidError,
  StackStateFormatUnsupportedError,
  StackUpgradeRequiredError,
  StackMustBeStoppedError,
  ServiceNotFoundError,
  ServiceNameConflictError,
  ServiceDependencyError,
  InitializationMismatchError,
  UnsupportedSnapshotError,
  NoSnapshotDataError,
  SnapshotTargetInvalidError,
  PortAllocationError,
  PortUnavailableError,
  GatewayActivationError,
  InvalidLogCursorError,
  PostgresClientError,
  type CreateStackError,
  type OpenStackError,
  type StackDiscoveryError,
  type StackStatusError,
  type StackCredentialsError,
  type PrepareStackError,
  type StackStartError,
  type StackStopError,
  type StackLogsError,
  type DestroyStackError,
  type StackError,
  type StackErrorTag,
  type LifecycleOutcome,
  isStackError,
  isStackErrorTag,
  PREPARE_STACK_ERROR_TAGS,
  STACK_STATUS_ERROR_TAGS,
  STACK_CREDENTIALS_ERROR_TAGS,
  STACK_START_ERROR_TAGS,
  STACK_STOP_ERROR_TAGS,
  STACK_LOGS_ERROR_TAGS,
  DESTROY_STACK_ERROR_TAGS,
  CREATE_STACK_ERROR_TAGS,
} from "./Errors.ts";
import {
  ownerLockExists,
  readOwnerMetadata,
  waitForOwnerRelease,
  type OwnerMetadata,
  type StackRuntimeEnvironmentValue,
} from "../state/Ownership.ts";
import { makeControlClient } from "../control/ControlServer.ts";
import {
  isMaintenanceTransportFailure,
  MaintenanceProtocolError,
} from "../control/MaintenanceProtocol.ts";
import { STACK_RPC_RELEASE, type StackRpcError, type StackRpcClient } from "../control/StackRpc.ts";
import {
  ensureSupervisor,
  defaultRuntimeEnvironment,
  StackRuntimeEnvironment,
} from "../supervisor/Launcher.ts";
import {
  ContainerEngineResolver,
  selectDefaultRuntimeSelection,
  nativeRuntimeBlockedForUid,
  NATIVE_ROOT_UNSUPPORTED_MESSAGE,
  type ContainerEngineResolverShape,
} from "../runtime/ContainerEngineResolver.ts";
import { statusForPersistedState } from "../supervisor/StatusProjection.ts";
import { EMPTY_LOG_CURSOR, readRetainedLogs, selectLogBatch } from "../supervisor/LogStore.ts";

export interface StartStackOptions {
  readonly services?: ReadonlyArray<ServiceInstanceId>;
}
export interface ServiceSelection {
  readonly services?: ReadonlyArray<ServiceInstanceId>;
}
export type ServiceConfigUpdate = import("./Service.ts").ServiceRestartPayload;
export type RestartStackOptions =
  | { readonly services?: never; readonly config?: StackConfig }
  | {
      readonly services: ReadonlyArray<ServiceInstanceId>;
      readonly updates?: ReadonlyArray<ServiceConfigUpdate>;
      readonly config?: never;
    };
export interface PrepareStackOptions {
  readonly config?: StackConfig;
  readonly services?: ReadonlyArray<ServiceInstanceId>;
  /** Synchronous progress observer for this caller-owned preparation. */
  readonly onProgress?: (status: ArtifactPreparationStatus) => void;
}
export interface CreateStackOptions {
  readonly projectRoot: string;
  readonly name?: string;
  readonly runtime?: StackRuntimePreference;
  readonly initialConfig: StackConfig;
}
export interface OpenStackOptions {
  readonly initialConfig?: StackConfig;
}
export interface FindStackOptions {
  readonly projectRoot: string;
  readonly name?: string;
}
export interface ListStacksOptions {
  readonly projectRoot?: string;
}

export interface InspectStackOptions {
  readonly config?: StackConfig;
}
interface PrepareStackInstance {
  readonly id: ServiceInstanceId;
  readonly service: ServiceKind;
  readonly artifacts: ReadonlyArray<{
    readonly identity: string;
    readonly outcome: "cached" | "downloaded" | "pulled";
  }>;
  readonly effectiveConfigFingerprint?: string;
}

export interface PrepareStackResult {
  readonly instances: ReadonlyArray<PrepareStackInstance>;
}

export interface EffectStack {
  readonly id: StackId;
  readonly services: EffectServiceCollection;
  readonly status: Effect.Effect<StackStatus, StackStatusError>;
  readonly followStatus: Stream.Stream<StackStatus, StackStatusError>;
  readonly credentials: Effect.Effect<EffectStackCredentials, StackCredentialsError>;
  readonly prepare: (
    options?: PrepareStackOptions,
  ) => Effect.Effect<PrepareStackResult, PrepareStackError>;
  readonly start: (options?: StartStackOptions) => Effect.Effect<StackStatus, StackStartError>;
  readonly sleep: (options?: ServiceSelection) => Effect.Effect<StackStatus, StackStartError>;
  readonly stop: (options?: ServiceSelection) => Effect.Effect<StackStatus, StackStopError>;
  readonly restart: (options?: RestartStackOptions) => Effect.Effect<StackStatus, StackStartError>;
  readonly destroy: (options?: ServiceSelection) => Effect.Effect<void, DestroyStackError>;
  readonly logs: (query?: LogQuery) => Effect.Effect<StackLogBatch, StackLogsError>;
  readonly followLogs: (query?: LogQuery) => Stream.Stream<StackLogEntry, StackLogsError>;
  /** Present when auto-select persisted native because the Docker daemon was down. */
  readonly dockerFallbackNotice?: string;
}

const optionOf = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none() : Option.some(value);

const descriptor = (state: PersistedStackState, id: StackId): StackDescriptor => ({
  id,
  projectRoot: state.identity.projectRoot,
  name: state.identity.stackName,
  branchContext: state.identity.branchContext,
  runtime: state.runtime,
  desiredLifecycle: state.registry.instances.some((instance) => instance.intent === "started")
    ? "running"
    : "stopped",
});

const environment = () =>
  Effect.serviceOption(StackRuntimeEnvironment).pipe(
    Effect.flatMap((configured) =>
      Option.isSome(configured) ? Effect.succeed(configured.value) : defaultRuntimeEnvironment,
    ),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isLifecycleOutcome = (value: unknown): value is LifecycleOutcome =>
  isRecord(value) &&
  ["requested", "affected", "succeeded", "failed"].every((key) => Array.isArray(value[key]));

const isStackRecovery = (value: unknown): value is StackRecovery =>
  isRecord(value) &&
  (value.operation === "stop" || value.operation === "destroy") &&
  typeof value.message === "string";

const isServiceDescriptor = (value: unknown): value is AnyServiceDescriptor =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.service === "string" &&
  (value.name === undefined || typeof value.name === "string") &&
  typeof value.enabled === "boolean" &&
  isRecord(value.config) &&
  isRecord(value.dependencies) &&
  isRecord(value.endpoints);

const isServiceDescriptorFor =
  <K extends ServiceKind>(service: K) =>
  (value: unknown): value is ServiceDescriptor<K> =>
    isServiceDescriptor(value) && value.service === service;

const isServiceStatus = (value: unknown): value is import("./Status.ts").ServiceStatus =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.service === "string" &&
  (value.name === undefined || typeof value.name === "string") &&
  typeof value.enabled === "boolean" &&
  (value.intent === "started" || value.intent === "stopped") &&
  typeof value.phase === "string" &&
  typeof value.activation === "string" &&
  Array.isArray(value.endpoints);

const isStackStatus = (value: unknown): value is StackStatus =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.lifecycle === "string" &&
  typeof value.desiredLifecycle === "string" &&
  isRecord(value.runtime) &&
  Array.isArray(value.capabilities) &&
  Array.isArray(value.instances) &&
  isRecord(value.endpoints);

const isServiceCredentials = <K extends ServiceKind>(
  service: K,
  value: unknown,
): value is ServiceCredentials<K> => {
  if (value === undefined) return service === "database";
  if (!isRecord(value)) return false;
  if (service === "database")
    return typeof value.url === "string" && typeof value.password === "string";
  if (service === "functions" || service === "storage") return true;
  return value.kind === "none";
};

const isServiceDescriptorList = (value: unknown): value is ReadonlyArray<AnyServiceDescriptor> =>
  Array.isArray(value) && value.every(isServiceDescriptor);

const isPrepareResult = (value: unknown): value is PrepareResult =>
  isRecord(value) &&
  Array.isArray(value.instances) &&
  value.instances.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.id === "string" &&
      typeof entry.service === "string" &&
      Array.isArray(entry.artifacts),
  );

const isStackLogBatch = (value: unknown): value is StackLogBatch =>
  isRecord(value) && Array.isArray(value.entries) && isRecord(value.cursor);

type ControlError =
  | StackRpcError
  | RpcClientError
  | SocketError
  | MaintenanceProtocolError
  | StackError;

type MutationContext = {
  readonly mutation: UncertainOperationError["mutation"];
  readonly instanceId?: string;
  readonly expectedCreationInputsId?: string;
};

class PreAdmissionOwnerLoss extends Data.TaggedError("PreAdmissionOwnerLoss")<{
  readonly ownerSessionId: string;
  readonly cause: RpcClientError;
}> {}

const isPreAdmissionOwnerLoss = (value: unknown): value is PreAdmissionOwnerLoss =>
  isRecord(value) &&
  value._tag === "PreAdmissionOwnerLoss" &&
  typeof value.ownerSessionId === "string" &&
  Predicate.isTagged(value.cause, "RpcClientError");

const stackErrorFactories: Partial<Record<StackErrorTag, (message: string) => StackError>> = {
  InvalidStackIdentityError: (message: string) => new InvalidStackIdentityError({ message }),
  InvalidProjectRootError: (message: string) => new InvalidProjectRootError({ message }),
  InvalidStackConfigError: (message: string) => new InvalidStackConfigError({ message }),
  StackVersionUnsupportedError: (message: string) => new StackVersionUnsupportedError({ message }),
  StackNotFoundError: (message: string) => new StackNotFoundError({ message }),
  StackOwnershipConflictError: (message: string) => new StackOwnershipConflictError({ message }),
  ServiceNotFoundError: (message: string) => new ServiceNotFoundError({ message }),
  ServiceNameConflictError: (message: string) => new ServiceNameConflictError({ message }),
  ServiceDependencyError: (message: string) => new ServiceDependencyError({ message }),
  InitializationMismatchError: (message: string) => new InitializationMismatchError({ message }),
  UnsupportedSnapshotError: (message: string) => new UnsupportedSnapshotError({ message }),
  NoSnapshotDataError: (message: string) => new NoSnapshotDataError({ message }),
  SnapshotTargetInvalidError: (message: string) => new SnapshotTargetInvalidError({ message }),
  StackRuntimeMismatchError: (message: string) => new StackRuntimeMismatchError({ message }),
  StackNotRunningError: (message: string) => new StackNotRunningError({ message }),
  StackMustBeStoppedError: (message: string) => new StackMustBeStoppedError({ message }),
  StackLifecycleConflictError: (message: string) => new StackLifecycleConflictError({ message }),
  StackStateInvalidError: (message: string) => new StackStateInvalidError({ message }),
  InvalidLogCursorError: (message: string) => new InvalidLogCursorError({ message }),
  StackStateFormatUnsupportedError: (message: string) =>
    new StackStateFormatUnsupportedError({ message }),
  StackUpgradeRequiredError: (message: string) => new StackUpgradeRequiredError({ message }),
  StackSecretMismatchError: (message: string) => new StackSecretMismatchError({ message }),
  InvalidJwtSigningMaterialError: (message: string) =>
    new InvalidJwtSigningMaterialError({ message }),
  PortAllocationError: (message: string) => new PortAllocationError({ message }),
  PortUnavailableError: (message: string) => new PortUnavailableError({ message }),
  GatewayActivationError: (message: string) => new GatewayActivationError({ message }),
  StackPreparationError: (message: string) => new StackPreparationError({ message }),
  ArtifactIntegrityError: (message: string) => new ArtifactIntegrityError({ message }),
  ContainerPullError: (message: string) => new ContainerPullError({ message }),
  StackRuntimeError: (message: string) => new StackRuntimeError({ message }),
  StackCleanupError: (message: string) => new StackCleanupError({ message }),
  ContainerEngineError: (message: string) => new ContainerEngineError({ message }),
  StackDestructionError: (message: string) => new StackDestructionError({ message }),
  PostgresClientError: (message: string) => new PostgresClientError({ message }),
};

const isOwnerUnreachable = (error: unknown): boolean =>
  Predicate.isTagged(error, "RpcClientError") ||
  Predicate.isTagged(error, "SocketError") ||
  Predicate.isTagged(error, "SocketOpenError") ||
  Predicate.isTagged(error, "SocketCloseError") ||
  isMaintenanceTransportFailure(error) ||
  (isRecord(error) && "reason" in error && isOwnerUnreachable(error.reason));

const isUncertainMutation = (value: unknown): value is UncertainOperationError["mutation"] =>
  typeof value === "string" &&
  ["create", "restore", "start", "sleep", "stop", "restart", "destroy", "exportSnapshot"].some(
    (mutation) => mutation === value,
  );

const isOwnerRetiringControlError = (value: unknown): value is StackRpcError =>
  isRecord(value) && value.tag === "OwnerRetiringError" && typeof value.ownerSessionId === "string";

const errorForRpc = (
  error: ControlError,
  context: {
    readonly stackId?: StackId;
    readonly mutation?: UncertainOperationError["mutation"];
    readonly instanceId?: string;
    readonly expectedCreationInputsId?: string;
  } = {},
): StackError => {
  if (isStackError(error)) return error;
  if (isOwnerUnreachable(error)) {
    if (context.stackId !== undefined && context.mutation !== undefined)
      return new UncertainOperationError({
        message: `The ${context.mutation} response was lost after dispatch: ${error.message}`,
        stackId: context.stackId,
        mutation: context.mutation,
        ...(context.instanceId === undefined ? {} : { instanceId: context.instanceId }),
        ...(context.expectedCreationInputsId === undefined
          ? {}
          : { expectedCreationInputsId: context.expectedCreationInputsId }),
      });
    return new StackOwnershipConflictError({
      message: `Stack owner is unreachable: ${error.message}`,
    });
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "tag" in error &&
    "message" in error &&
    typeof error.tag === "string" &&
    typeof error.message === "string"
  ) {
    if (
      error.tag === "UncertainOperationError" &&
      "stackId" in error &&
      typeof error.stackId === "string" &&
      isStackId(error.stackId) &&
      "mutation" in error &&
      isUncertainMutation(error.mutation)
    ) {
      return new UncertainOperationError({
        message: error.message,
        stackId: error.stackId,
        mutation: error.mutation,
        ...(typeof error.instanceId === "string" ? { instanceId: error.instanceId } : {}),
        ...(typeof error === "object" &&
        error !== null &&
        "operationId" in error &&
        typeof error.operationId === "string"
          ? { operationId: error.operationId }
          : {}),
        ...(typeof error === "object" &&
        error !== null &&
        "expectedCreationInputsId" in error &&
        typeof error.expectedCreationInputsId === "string"
          ? { expectedCreationInputsId: error.expectedCreationInputsId }
          : {}),
        ...(context.expectedCreationInputsId === undefined ||
        ("expectedCreationInputsId" in error && typeof error.expectedCreationInputsId === "string")
          ? {}
          : { expectedCreationInputsId: context.expectedCreationInputsId }),
      });
    }
    if (
      error.tag === "OwnerRetiringError" &&
      "stackId" in error &&
      "ownerSessionId" in error &&
      typeof error.stackId === "string" &&
      isStackId(error.stackId) &&
      typeof error.ownerSessionId === "string"
    )
      return new OwnerRetiringError({
        message: error.message,
        stackId: error.stackId,
        ownerSessionId: error.ownerSessionId,
      });
    if (
      error.tag === "StackLifecycleConflictError" &&
      ("instanceId" in error || "outcome" in error || "recovery" in error)
    )
      return new StackLifecycleConflictError({
        message: error.message,
        ...(typeof error.stackId === "string" && isStackId(error.stackId)
          ? { stackId: error.stackId }
          : {}),
        ...(typeof error.instanceId === "string" ? { instanceId: error.instanceId } : {}),
        ...("outcome" in error && isLifecycleOutcome(error.outcome)
          ? { outcome: error.outcome }
          : {}),
        ...("recovery" in error && isStackRecovery(error.recovery)
          ? { recovery: error.recovery }
          : {}),
      });
    if (
      error.tag === "StackDestructionError" &&
      "outcome" in error &&
      isLifecycleOutcome(error.outcome)
    )
      return new StackDestructionError({ message: error.message, outcome: error.outcome });
    if (isStackErrorTag(error.tag)) {
      const factory = stackErrorFactories[error.tag];
      if (factory !== undefined) return factory(error.message);
    }
    return new StackStateInvalidError({ message: error.message });
  }
  return new StackStateInvalidError({ message: error.message });
};

const isNarrowError = <Tags extends ReadonlyArray<StackErrorTag>>(
  error: StackError,
  tags: Tags,
): error is Extract<StackError, { _tag: Tags[number] }> => tags.some((tag) => tag === error._tag);

const narrowError = <Tags extends ReadonlyArray<StackErrorTag>>(
  error: ControlError,
  tags: Tags,
  fallback: (message: string) => Extract<StackError, { _tag: Tags[number] }>,
): Extract<StackError, { _tag: Tags[number] }> => {
  const mapped = errorForRpc(error);
  return isNarrowError(mapped, tags) ? mapped : fallback(mapped.message);
};

const statusError = (error: ControlError): StackStatusError =>
  narrowError(error, STACK_STATUS_ERROR_TAGS, (message) => new StackStateInvalidError({ message }));
const credentialsError = (error: ControlError): StackCredentialsError =>
  narrowError(
    error,
    STACK_CREDENTIALS_ERROR_TAGS,
    (message) => new StackNotRunningError({ message }),
  );
const startError = (error: ControlError): StackStartError =>
  narrowError(error, STACK_START_ERROR_TAGS, (message) => new StackStateInvalidError({ message }));
const stopError = (error: ControlError): StackStopError =>
  narrowError(
    error,
    STACK_STOP_ERROR_TAGS,
    (message) => new StackLifecycleConflictError({ message }),
  );
const logsError = (error: ControlError): StackLogsError =>
  narrowError(error, STACK_LOGS_ERROR_TAGS, (message) => new StackStateInvalidError({ message }));
const destroyError = (error: ControlError): DestroyStackError =>
  narrowError(error, DESTROY_STACK_ERROR_TAGS, (message) => new StackDestructionError({ message }));
const createError = (error: unknown): CreateStackError =>
  isStackError(error) && isNarrowError(error, CREATE_STACK_ERROR_TAGS)
    ? error
    : new StackStateInvalidError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });

/** Internal control-transport seam used by public lifecycle integration tests. */
export interface HandleDependencies {
  readonly resolveOwner: (
    launch: boolean,
  ) => Effect.Effect<Option.Option<OwnerResolution>, StackError>;
  readonly readOfflineState: Effect.Effect<Option.Option<PersistedStackState>, StackError>;
  readonly readPersistedState: Effect.Effect<Option.Option<PersistedStackState>, StackError>;
  readonly readLogs: (query?: LogQuery) => Effect.Effect<StackLogBatch, StackLogsError>;
  readonly waitForRelease: (ownerSessionId?: string) => Effect.Effect<void, StackStopError>;
  readonly prepare: (
    options?: PrepareStackOptions,
  ) => Effect.Effect<PrepareStackResult, PrepareStackError>;
  readonly fingerprintCreationInputs?: (options: unknown) => Effect.Effect<string, StackError>;
}

/** @internal Owner metadata together with whether this handle launched the owner. */
interface OwnerResolution {
  readonly owner: OwnerMetadata;
  readonly launched: boolean;
}

export const makeHandle = (id: StackId, options: HandleDependencies): Effect.Effect<EffectStack> =>
  Effect.sync(() => {
    const isStoppedState = (state: PersistedStackState): boolean =>
      state.registry.instances.every(
        (instance) => instance.intent === "stopped" && instance.pendingOperation === null,
      );
    const stackNotFound = () => new StackNotFoundError({ message: "Stack state was not found" });
    const serviceSelectionPayload = (selection: ServiceSelection | undefined) =>
      selection?.services === undefined ? {} : { services: selection.services };
    type ResolvedClient = {
      readonly client: ReturnType<typeof makeControlClient>;
      readonly ownerSessionId: string;
    };
    const resolveClient = (
      launch: boolean,
      protocol: "rpc" | "maintenance" = "rpc",
    ): Effect.Effect<ResolvedClient, StackError> =>
      options.resolveOwner(launch).pipe(
        Effect.flatMap((resolution): Effect.Effect<ResolvedClient, StackError> =>
          Option.isSome(resolution)
            ? protocol === "rpc" && resolution.value.owner.rpcRelease !== STACK_RPC_RELEASE
              ? Effect.fail(
                  new StackUpgradeRequiredError({
                    message: `Stack owner release ${resolution.value.owner.rpcRelease} requires stop before start`,
                    expectedRelease: STACK_RPC_RELEASE,
                    actualRelease: resolution.value.owner.rpcRelease,
                  }),
                )
              : Effect.succeed({
                  client: makeControlClient(resolution.value.owner.endpoint, {
                    stackId: id,
                    ownerSessionId: resolution.value.owner.ownerSessionId,
                    rpcRelease:
                      protocol === "rpc" ? STACK_RPC_RELEASE : resolution.value.owner.rpcRelease,
                  }),
                  ownerSessionId: resolution.value.owner.ownerSessionId,
                })
            : Effect.fail(
                new StackOwnershipConflictError({ message: "No Supervisor owns this stack" }),
              ),
        ),
      );
    const invoke = <A, E extends StackError>(
      call: (rpc: StackRpcClient) => Effect.Effect<A, StackRpcError | RpcClientError>,
      mapError: (error: ControlError) => E,
      launch = false,
      mutation?: MutationContext,
    ): Effect.Effect<A, E> => {
      const rawAttempt = (): Effect.Effect<A, ControlError | PreAdmissionOwnerLoss> =>
        resolveClient(launch).pipe(
          Effect.flatMap(({ client, ownerSessionId }) => {
            // Opening the RPC channel precedes handler admission. A lost owner here is safe to
            // retry once; errors after `call` starts may represent an already committed mutation.
            return client.rpc.pipe(
              Effect.catchIf(
                (error): error is RpcClientError => isOwnerUnreachable(error),
                (cause) =>
                  Effect.fail(
                    new PreAdmissionOwnerLoss({
                      ownerSessionId,
                      cause,
                    }),
                  ),
              ),
              Effect.flatMap((rpc) => Effect.suspend(() => call(rpc))),
              Effect.scoped,
            );
          }),
        );
      // Retirement is reported before admission. Wait for that owner to release, then
      // resolve a fresh owner once; an admitted or ambiguous operation is never replayed.
      return rawAttempt().pipe(
        Effect.catchIf(
          (error): error is StackRpcError | PreAdmissionOwnerLoss =>
            isOwnerRetiringControlError(error) || isPreAdmissionOwnerLoss(error),
          (error) =>
            options.waitForRelease(error.ownerSessionId).pipe(
              Effect.mapError((waitError): ControlError => waitError),
              Effect.andThen(rawAttempt()),
            ),
        ),
        Effect.mapError((error) =>
          mapError(
            isPreAdmissionOwnerLoss(error)
              ? new StackOwnershipConflictError({
                  message: `Stack owner ${error.ownerSessionId} became unreachable before admission`,
                  cause: error.cause,
                })
              : mutation === undefined
                ? error
                : errorForRpc(error, { stackId: id, ...mutation }),
          ),
        ),
      );
    };
    const destroyAndAwaitOwner: Effect.Effect<void, DestroyStackError> = resolveClient(true).pipe(
      Effect.mapError(destroyError),
      Effect.flatMap(({ client, ownerSessionId }) =>
        Effect.scoped(
          client.rpc.pipe(
            Effect.mapError(
              (cause: RpcClientError) =>
                new PreAdmissionOwnerLoss({
                  ownerSessionId,
                  cause,
                }),
            ),
            Effect.flatMap((rpc) => rpc.destroy({})),
          ),
        ).pipe(
          Effect.mapError((error) =>
            destroyError(
              isPreAdmissionOwnerLoss(error)
                ? new StackOwnershipConflictError({
                    message: `Stack owner ${error.ownerSessionId} became unreachable before admission`,
                    cause: error.cause,
                  })
                : errorForRpc(error, { stackId: id, mutation: "destroy" }),
            ),
          ),
          Effect.andThen(
            options.waitForRelease(ownerSessionId).pipe(
              Effect.mapError(
                (error) =>
                  new StackDestructionError({
                    message: error.message,
                    cause: error,
                  }),
              ),
            ),
          ),
        ),
      ),
    );
    const destroy = (selection?: ServiceSelection): Effect.Effect<void, DestroyStackError> =>
      selection?.services !== undefined && selection.services.length === 0
        ? Effect.void
        : selection?.services === undefined
          ? Effect.suspend(() =>
              options.readPersistedState.pipe(
                Effect.mapError(destroyError),
                Effect.flatMap((state) =>
                  Option.isNone(state) ? Effect.fail(stackNotFound()) : destroyAndAwaitOwner,
                ),
              ),
            )
          : invoke((rpc) => rpc.destroy(serviceSelectionPayload(selection)), destroyError, true, {
              mutation: "destroy",
            });
    const status: Effect.Effect<StackStatus, StackStatusError> = Effect.suspend(
      (): Effect.Effect<StackStatus, StackStatusError> => {
        const rpcStatus = invoke((rpc) => rpc.status(undefined), statusError);
        return rpcStatus.pipe(
          Effect.catchTag("StackOwnershipConflictError", (ownershipError) =>
            options.readOfflineState.pipe(
              Effect.mapError(statusError),
              Effect.flatMap((state): Effect.Effect<StackStatus, StackStatusError> => {
                if (Option.isNone(state)) return Effect.fail(stackNotFound());
                if (isStoppedState(state.value)) {
                  return statusForPersistedState(id, state.value);
                }
                return Effect.fail(
                  new StackOwnershipConflictError({ message: "No Supervisor owns this stack" }),
                );
              }),
              Effect.catchTag("StackOwnershipConflictError", () => Effect.fail(ownershipError)),
            ),
          ),
        );
      },
    );
    const credentials: Effect.Effect<EffectStackCredentials, StackCredentialsError> =
      Effect.suspend((): Effect.Effect<EffectStackCredentials, StackCredentialsError> =>
        invoke((rpc) => rpc.credentials(undefined), credentialsError, true).pipe(
          Effect.catchTag("StackOwnershipConflictError", (ownershipError) => {
            const offline: Effect.Effect<never, StackCredentialsError> =
              options.readOfflineState.pipe(
                Effect.mapError(credentialsError),
                Effect.flatMap((state): Effect.Effect<never, StackCredentialsError> =>
                  Option.isNone(state)
                    ? Effect.fail(stackNotFound())
                    : isStoppedState(state.value)
                      ? Effect.fail(
                          new StackNotRunningError({
                            stackId: id,
                            message: "Stack is not running",
                          }),
                        )
                      : Effect.fail(ownershipError),
                ),
                Effect.catchTag("StackOwnershipConflictError", () => Effect.fail(ownershipError)),
              );
            return offline;
          }),
        ),
      );
    const start = (startOptions?: StartStackOptions) => {
      return invoke((rpc) => rpc.start(serviceSelectionPayload(startOptions)), startError, true, {
        mutation: "start",
      }).pipe(
        Effect.tapError(() =>
          options.readPersistedState.pipe(
            Effect.flatMap((state) =>
              Option.isSome(state) && isStoppedState(state.value)
                ? options.waitForRelease().pipe(Effect.ignore)
                : Effect.void,
            ),
            Effect.ignore,
          ),
        ),
      );
    };
    const logsStateError = (error: StackError): StackLogsError =>
      isNarrowError(error, STACK_LOGS_ERROR_TAGS)
        ? error
        : new StackStateInvalidError({ message: error.message, cause: error });
    const sleep = (selection?: ServiceSelection) =>
      invoke((rpc) => rpc.sleep(serviceSelectionPayload(selection)), startError, true, {
        mutation: "sleep",
      });
    const stop = (selection?: ServiceSelection) =>
      invoke((rpc) => rpc.stop(serviceSelectionPayload(selection)), stopError, true, {
        mutation: "stop",
      });
    const restart = (restartOptions?: RestartStackOptions) =>
      invoke(
        (rpc) => rpc.restart(restartOptions === undefined ? {} : restartOptions),
        startError,
        true,
        { mutation: "restart" },
      );
    const prepare = (
      prepareOptions?: PrepareStackOptions,
    ): Effect.Effect<PrepareStackResult, PrepareStackError> => options.prepare(prepareOptions);
    const decodeService = <A>(
      value: unknown,
      predicate: (value: unknown) => value is A,
      label: string,
    ): Effect.Effect<A, StackError> =>
      predicate(value)
        ? Effect.succeed(value)
        : Effect.fail(new StackStateInvalidError({ message: `Invalid ${label} response` }));
    const serviceCall = <A>(
      call: (rpc: StackRpcClient) => Effect.Effect<A, StackRpcError | RpcClientError>,
      mutation?: MutationContext,
    ): Effect.Effect<A, StackError> =>
      invoke(call, (error) => errorForRpc(error, { stackId: id, ...mutation }), true, mutation);
    const serviceStream = <A>(
      call: (rpc: StackRpcClient) => Stream.Stream<A, StackRpcError | RpcClientError>,
    ): Stream.Stream<A, StackError> =>
      Stream.unwrap(
        resolveClient(true).pipe(
          Effect.flatMap(({ client }) =>
            client.rpc.pipe(
              Effect.map((rpc) => call(rpc).pipe(Stream.mapError(errorForRpc))),
              Effect.mapError(errorForRpc),
            ),
          ),
          Effect.mapError(errorForRpc),
        ),
      );
    const serviceStatus = (instanceId: ServiceInstanceId) =>
      serviceCall((rpc) => rpc.serviceStatus({ id: instanceId })).pipe(
        Effect.flatMap((value) => decodeService(value, isServiceStatus, "service status")),
      );
    const serviceDescribe = (instanceId: ServiceInstanceId) =>
      serviceCall((rpc) => rpc.servicesGet({ id: instanceId })).pipe(
        Effect.flatMap((value) => decodeService(value, isServiceDescriptor, "service descriptor")),
      );
    const serviceCredentials = <K extends ServiceKind>(
      service: K,
      instanceId: ServiceInstanceId,
    ): Effect.Effect<ServiceCredentials<K>, StackError> =>
      serviceCall((rpc) => rpc.serviceCredentials({ id: instanceId })).pipe(
        Effect.flatMap((value) =>
          isServiceCredentials(service, value)
            ? Effect.succeed(value)
            : Effect.fail(new StackStateInvalidError({ message: "Invalid service credentials" })),
        ),
      );
    const serviceHandle = <K extends ServiceKind>(
      initial: ServiceDescriptor<K>,
    ): EffectServiceInstance<K> => ({
      id: initial.id,
      service: initial.service,
      name: initial.name,
      describe: serviceDescribe(initial.id).pipe(
        Effect.flatMap((value) =>
          decodeService(value, isServiceDescriptorFor(initial.service), "service descriptor"),
        ),
      ),
      status: serviceStatus(initial.id),
      credentials: serviceCredentials(initial.service, initial.id),
      prepare: serviceCall((rpc) => rpc.servicePrepare({ id: initial.id })).pipe(
        Effect.flatMap((value) => decodeService(value, isPrepareResult, "prepare result")),
      ),
      start: serviceCall((rpc) => rpc.serviceStart({ id: initial.id }), {
        mutation: "start",
        instanceId: initial.id,
      }).pipe(Effect.flatMap((value) => decodeService(value, isServiceStatus, "service status"))),
      sleep: serviceCall((rpc) => rpc.serviceSleep({ id: initial.id }), {
        mutation: "sleep",
        instanceId: initial.id,
      }).pipe(Effect.flatMap((value) => decodeService(value, isServiceStatus, "service status"))),
      stop: serviceCall((rpc) => rpc.serviceStop({ id: initial.id }), {
        mutation: "stop",
        instanceId: initial.id,
      }).pipe(Effect.flatMap((value) => decodeService(value, isServiceStatus, "service status"))),
      restart: (restartOptions) =>
        Effect.gen(function* () {
          const payload = yield* Schema.decodeUnknownEffect(ServiceRestartPayloadSchema)({
            id: initial.id,
            service: initial.service,
            ...(restartOptions?.config === undefined ? {} : { config: restartOptions.config }),
          }).pipe(
            Effect.mapError(
              (error) =>
                new StackStateInvalidError({
                  message: `Invalid service restart request: ${String(error)}`,
                  cause: error,
                }),
            ),
          );
          return yield* serviceCall((rpc) => rpc.serviceRestart(payload), {
            mutation: "restart",
            instanceId: initial.id,
          }).pipe(
            Effect.flatMap((value) => decodeService(value, isServiceStatus, "service status")),
          );
        }),
      destroy: serviceCall((rpc) => rpc.serviceDestroy({ id: initial.id }), {
        mutation: "destroy",
        instanceId: initial.id,
      }).pipe(Effect.asVoid),
      exportSnapshot: (snapshotOptions) =>
        serviceCall(
          (rpc) =>
            rpc.serviceExportSnapshot({ id: initial.id, destination: snapshotOptions.destination }),
          { mutation: "exportSnapshot", instanceId: initial.id },
        ).pipe(
          Effect.flatMap((value) =>
            decodeService(
              value,
              (entry): entry is SnapshotDescriptor => Schema.is(SnapshotDescriptorSchema)(entry),
              "snapshot descriptor",
            ),
          ),
        ),
      restoreSnapshot: (snapshotOptions) =>
        serviceCall(
          (rpc) => rpc.serviceRestoreSnapshot({ id: initial.id, source: snapshotOptions.source }),
          { mutation: "restore", instanceId: initial.id },
        ).pipe(
          Effect.flatMap((value) =>
            decodeService(
              value,
              (entry): entry is SnapshotDescriptor => Schema.is(SnapshotDescriptorSchema)(entry),
              "snapshot descriptor",
            ),
          ),
        ),
      logs: (query) =>
        serviceCall((rpc) =>
          rpc.serviceLogs({ id: initial.id, ...(query === undefined ? {} : { query }) }),
        ).pipe(Effect.flatMap((value) => decodeService(value, isStackLogBatch, "service logs"))),
      followLogs: (query) =>
        Stream.paginate({ cursor: query?.cursor, first: true }, ({ cursor, first }) => {
          const { cursor: _initialCursor, tail: _tail, ...baseQuery } = query ?? {};
          const request = serviceCall((rpc) =>
            rpc.serviceLogs({
              id: initial.id,
              query: {
                ...baseQuery,
                ...(first && query?.tail !== undefined ? { tail: query.tail } : {}),
                ...(cursor === undefined || cursor.opaque === EMPTY_LOG_CURSOR.opaque
                  ? {}
                  : { cursor }),
              },
            }),
          ).pipe(Effect.flatMap((value) => decodeService(value, isStackLogBatch, "service logs")));
          const delayed = first
            ? request
            : Effect.schedule(Effect.void, Schedule.duration("100 millis")).pipe(
                Effect.andThen(request),
              );
          return delayed.pipe(
            Effect.map(
              (batch) =>
                [
                  batch.entries,
                  batch.running
                    ? Option.some({ cursor: batch.cursor, first: false })
                    : Option.none(),
                ] as const,
            ),
          );
        }),
      followStatus: serviceStream((rpc) => rpc.serviceFollowStatus({ id: initial.id })).pipe(
        Stream.mapEffect((value) => decodeService(value, isServiceStatus, "service status")),
      ),
    });
    const serviceHandleFor = (value: AnyServiceDescriptor): AnyEffectServiceInstance => {
      switch (value.service) {
        case "database":
          return serviceHandle(value);
        case "rest":
          return serviceHandle(value);
        case "auth":
          return serviceHandle(value);
        case "realtime":
          return serviceHandle(value);
        case "storage":
          return serviceHandle(value);
        case "functions":
          return serviceHandle(value);
        case "studio":
          return serviceHandle(value);
        case "mail":
          return serviceHandle(value);
        case "analytics":
          return serviceHandle(value);
        case "pooler":
          return serviceHandle(value);
      }
    };
    const services: EffectServiceCollection = {
      create: (serviceOptions) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(EffectCreateServiceOptionsSchema)(
            serviceOptions,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new InvalidStackConfigError({
                  message: `Invalid service creation options: ${String(cause)}`,
                  cause,
                }),
            ),
          );
          const expectedCreationInputsId =
            options.fingerprintCreationInputs === undefined
              ? undefined
              : yield* options.fingerprintCreationInputs(decoded);
          const value = yield* (() => {
            switch (decoded.service) {
              case "database":
                return serviceCall((rpc) => rpc.servicesCreate(decoded), {
                  mutation: "create",
                  expectedCreationInputsId,
                });
              case "rest":
                return serviceCall((rpc) => rpc.servicesCreate(decoded), {
                  mutation: "create",
                  expectedCreationInputsId,
                });
              case "auth":
                return serviceCall((rpc) => rpc.servicesCreate(decoded), {
                  mutation: "create",
                  expectedCreationInputsId,
                });
              case "realtime":
                return serviceCall((rpc) => rpc.servicesCreate(decoded), {
                  mutation: "create",
                  expectedCreationInputsId,
                });
              case "storage":
                return serviceCall((rpc) => rpc.servicesCreate(decoded), {
                  mutation: "create",
                  expectedCreationInputsId,
                });
              case "functions":
                return serviceCall((rpc) => rpc.servicesCreate(decoded), {
                  mutation: "create",
                  expectedCreationInputsId,
                });
              case "studio":
                return serviceCall((rpc) => rpc.servicesCreate(decoded), {
                  mutation: "create",
                  expectedCreationInputsId,
                });
              case "mail":
                return serviceCall((rpc) => rpc.servicesCreate(decoded), {
                  mutation: "create",
                  expectedCreationInputsId,
                });
              case "analytics":
                return serviceCall((rpc) => rpc.servicesCreate(decoded), {
                  mutation: "create",
                  expectedCreationInputsId,
                });
              case "pooler":
                return serviceCall((rpc) => rpc.servicesCreate(decoded), {
                  mutation: "create",
                  expectedCreationInputsId,
                });
            }
          })();
          const descriptor = yield* decodeService(
            value,
            isServiceDescriptorFor(serviceOptions.service),
            "service descriptor",
          );
          return serviceHandle(descriptor);
        }),
      get: (ref) =>
        serviceCall((rpc) => rpc.servicesGet(ref)).pipe(
          Effect.flatMap((value) =>
            decodeService(value, isServiceDescriptor, "service descriptor"),
          ),
          Effect.map(serviceHandleFor),
        ),
      list: serviceCall((rpc) => rpc.servicesList()).pipe(
        Effect.flatMap((value) => decodeService(value, isServiceDescriptorList, "service list")),
      ),
    };
    const logs = (query?: LogQuery): Effect.Effect<StackLogBatch, StackLogsError> =>
      invoke((rpc) => rpc.logs(query ?? {}), logsError).pipe(
        Effect.catchTag("StackOwnershipConflictError", (ownershipError) => {
          const ownerStopped = options.readPersistedState.pipe(Effect.mapError(logsStateError));
          return ownerStopped.pipe(
            Effect.flatMap((state) => {
              if (Option.isNone(state)) return Effect.fail(stackNotFound());
              const teardown = isStoppedState(state.value);
              if (!teardown) return Effect.fail(ownershipError);
              return Effect.suspend(() =>
                // During an owner stop the control socket can close before its metadata/lease are
                // released. Re-check ownership before each read and retry only that typed
                // transition; a live owner or other log failure remains visible.
                options.readLogs(query),
              ).pipe(
                Effect.retry({
                  schedule: Schedule.spaced("25 millis").pipe(Schedule.upTo({ times: 200 })),
                  while: (error) => error instanceof StackOwnershipConflictError,
                }),
              );
            }),
          );
        }),
      );
    return {
      id,
      services,
      status,
      followStatus: serviceStream((rpc) => rpc.followStatus(undefined)).pipe(
        Stream.mapEffect((value) => decodeService(value, isStackStatus, "stack status")),
        Stream.mapError(statusError),
      ),
      credentials,
      prepare,
      start,
      sleep,
      stop,
      restart,
      destroy,
      logs,
      followLogs: (query) =>
        Stream.paginate({ cursor: query?.cursor, first: true }, ({ cursor, first }) => {
          const { cursor: _initialCursor, tail: _tail, ...baseQuery } = query ?? {};
          const pollQuery = {
            ...baseQuery,
            ...(first && query?.tail !== undefined ? { tail: query.tail } : {}),
            ...(cursor === undefined || cursor.opaque === EMPTY_LOG_CURSOR.opaque
              ? {}
              : { cursor }),
          };
          const request = logs(pollQuery);
          const delayed = first
            ? request
            : Effect.schedule(Effect.void, Schedule.duration("100 millis")).pipe(
                Effect.andThen(request),
              );
          return delayed.pipe(
            Effect.map(
              (batch) =>
                [
                  batch.entries,
                  batch.running
                    ? Option.some({ cursor: batch.cursor, first: false })
                    : Option.none(),
                ] as const,
            ),
          );
        }),
    } satisfies EffectStack;
  });

const stateInitial = (
  identity: StackIdentity,
  runtime: StackRuntime,
  seeded?: {
    readonly definition: StackDefinition;
    readonly services: SeededServiceRegistry;
  },
  secrets: PersistedStackState["secrets"] = {},
): PersistedStackState => {
  const api = seeded?.definition.listeners.api;
  const security = seeded?.definition.security;
  const signing = security?.jwt.signing;
  const persistedSecurity = {
    jwt: {
      issuer: security?.jwt.issuer ?? null,
      expirySeconds: security?.jwt.expirySeconds ?? 3_600,
      signing:
        signing === null || signing === undefined
          ? { kind: "symmetric" as const, secret: { slot: AUTH_JWT_SECRET_SLOT } }
          : signing,
    },
  };
  return {
    format: STACK_STATE_FORMAT,
    identity: toPersistedIdentity(identity),
    runtime,
    preparation: seeded?.definition.preparation ?? "background",
    security: persistedSecurity,
    listeners:
      api === undefined
        ? {}
        : {
            api: api.enabled
              ? {
                  enabled: true,
                  address: api.address,
                  ...(typeof api.port === "number" ? { port: api.port } : {}),
                }
              : { enabled: false },
          },
    registry: seeded?.services.registry ?? {
      initialized: true,
      instances: [],
      defaultInstanceIds: {},
    },
    ports: [],
    privatePorts: [],
    secrets,
  };
};

const listenerEndpoint = (
  listener: StackDefinition["listeners"][keyof StackDefinition["listeners"]],
):
  | { readonly address: string; readonly port: "auto" | number }
  | {
      readonly enabled: false;
    } =>
  listener.enabled
    ? {
        address: listener.address,
        port: listener.port === "automatic" ? "auto" : listener.port,
      }
    : { enabled: false };

const candidateEndpoints = (
  definition: StackDefinition,
  service: ServiceKind,
): Readonly<Record<string, unknown>> => {
  switch (service) {
    case "database":
      return { sql: listenerEndpoint(definition.listeners.database) };
    case "functions":
      return { inspector: listenerEndpoint(definition.listeners.functionsInspector) };
    case "studio":
      return { studio: listenerEndpoint(definition.listeners.studio) };
    case "mail":
      return {
        smtp: listenerEndpoint(definition.listeners.smtp),
        pop3: listenerEndpoint(definition.listeners.pop3),
        mailUi: listenerEndpoint(definition.listeners.mailUi),
      };
    case "pooler":
      return { pooler: listenerEndpoint(definition.listeners.pooler) };
    default:
      return {};
  }
};

/** Applies candidate defaults to their persisted identities while retaining dynamic services. */
const prospectiveRegistry = (
  state: PersistedStackState,
  definition: StackDefinition,
): Effect.Effect<PersistedServiceRegistry, InvalidStackConfigError> =>
  Schema.decodeUnknownEffect(PersistedServiceRegistrySchema)({
    ...state.registry,
    instances: state.registry.instances.map((instance) => {
      if (state.registry.defaultInstanceIds[instance.service] !== instance.id) return instance;
      const capability = definition.capabilities[instance.service];
      return {
        ...instance,
        config: {
          ...instance.config,
          ...capability,
          endpoints: {
            ...instance.config.endpoints,
            ...candidateEndpoints(definition, instance.service),
          },
        },
      };
    }),
  }).pipe(
    Effect.mapError(
      (error) =>
        new InvalidStackConfigError({
          message: `Candidate service registry failed validation: ${String(error)}`,
          cause: error,
        }),
    ),
  );

type ChildProcessSpawnerValue = Context.Service.Shape<
  typeof ChildProcessSpawner.ChildProcessSpawner
>;

const handleDependencies = (options: {
  readonly environment: StackRuntimeEnvironmentValue;
  readonly store: StackStateStore;
  readonly id: StackId;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly spawner: ChildProcessSpawnerValue;
  readonly containerEngineResolver?: ContainerEngineResolverShape;
}) => {
  const provide = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Crypto.Crypto>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, options.fileSystem),
      Effect.provideService(Path.Path, options.path),
      Effect.provideService(Crypto.Crypto, options.crypto),
    );
  const resolveOwner = (launch: boolean) =>
    launch
      ? Effect.scoped(
          ensureSupervisor({
            stackId: options.id,
            stateStore: options.store,
            environment: options.environment,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, options.fileSystem),
            Effect.provideService(Path.Path, options.path),
            Effect.provideService(Crypto.Crypto, options.crypto),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
          ),
        ).pipe(Effect.map((resolution) => Option.some(resolution)))
      : provide(
          readOwnerMetadata(options.environment.stateRoot, options.id, options.environment),
        ).pipe(
          Effect.map((owner) =>
            owner === undefined ? Option.none() : Option.some({ owner, launched: false }),
          ),
        );
  const ensureOffline = () =>
    provide(readOwnerMetadata(options.environment.stateRoot, options.id, options.environment)).pipe(
      Effect.flatMap((owner) =>
        owner !== undefined
          ? Effect.fail(
              new StackOwnershipConflictError({ message: "A Supervisor still owns this stack" }),
            )
          : provide(ownerLockExists(options.environment.stateRoot, options.id)).pipe(
              Effect.flatMap((locked) =>
                locked
                  ? Effect.fail(
                      new StackOwnershipConflictError({
                        message: "The stack ownership lease is still held",
                      }),
                    )
                  : Effect.void,
              ),
            ),
      ),
    );
  const readOfflineState = ensureOffline().pipe(
    Effect.andThen(provide(options.store.read(options.id))),
    Effect.map(optionOf),
  );
  const readPersistedState = provide(options.store.read(options.id)).pipe(Effect.map(optionOf));
  const directPrepareError = (cause: unknown): PrepareStackError => {
    if (isStackError(cause) && isNarrowError(cause, PREPARE_STACK_ERROR_TAGS)) return cause;
    return new StackPreparationError({
      stackId: options.id,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  };
  const prepare = (
    prepareOptions?: PrepareStackOptions,
  ): Effect.Effect<PrepareStackResult, PrepareStackError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* provide(options.store.read(options.id)).pipe(
          Effect.mapError(directPrepareError),
        );
        if (state === undefined)
          return yield* new StackStateInvalidError({
            stackId: options.id,
            message: "Stack state is missing",
          });

        const requested =
          prepareOptions?.services === undefined
            ? state.registry.instances
                .filter((instance) => instance.config.enabled)
                .map((instance) => instance.id)
            : [...prepareOptions.services];
        const uniqueRequested = [...new Set(requested)];
        for (const id of uniqueRequested) {
          const instance = state.registry.instances.find((entry) => entry.id === id);
          if (instance === undefined)
            return yield* new ServiceNotFoundError({
              instanceId: id,
              message: `Service instance ${id} was not found`,
            });
          if (!instance.config.enabled)
            return yield* new InvalidStackConfigError({
              stackId: options.id,
              capability: instance.service,
              message: `Service instance ${id} is disabled`,
            });
        }
        if (uniqueRequested.length === 0) return { instances: [] };

        // Compile candidate settings and secret declarations without writing state. The
        // persisted registry remains the authority for identities and dynamic services.
        const candidate =
          prepareOptions?.config === undefined
            ? undefined
            : yield* compileStack({
                projectRoot: state.identity.projectRoot,
                runtime: state.runtime,
                config: prepareOptions.config,
                registry: state.registry,
              }).pipe(
                Effect.provideService(Path.Path, options.path),
                Effect.mapError(directPrepareError),
              );
        const candidateRegistry =
          candidate === undefined
            ? state.registry
            : yield* prospectiveRegistry(state, candidate.definition).pipe(
                Effect.mapError(directPrepareError),
              );
        const plan = yield* createExecutionPlan(
          state.runtime,
          candidateRegistry,
          undefined,
          new Set(uniqueRequested),
        ).pipe(Effect.mapError(directPrepareError));
        const selected = dependencyClosure(plan, uniqueRequested);
        const workloads = plan.workloads.filter((workload) => selected.has(workload.instanceId));
        for (const workload of workloads)
          prepareOptions?.onProgress?.({
            workloadId: workload.id,
            capability: workload.capability,
            state: "queued",
          });

        const preparer = yield* makeProductionRuntimeArtifactPreparer({
          stateRoot: options.environment.stateRoot,
          runtime: state.runtime,
          ...(options.environment.artifactCacheRoot === undefined
            ? {}
            : { artifactCacheRoot: options.environment.artifactCacheRoot }),
          ...(options.containerEngineResolver === undefined
            ? {}
            : { containerEngineResolver: options.containerEngineResolver }),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, options.fileSystem),
          Effect.provideService(Path.Path, options.path),
          Effect.provideService(Crypto.Crypto, options.crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
          Effect.mapError(directPrepareError),
        );
        const artifacts = yield* Effect.forEach(
          workloads,
          (workload) => preparer.prepare(state.runtime, workload, prepareOptions?.onProgress),
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError(directPrepareError));
        const artifactsByInstance = new Map<ServiceInstanceId, typeof artifacts>();
        for (const artifact of artifacts) {
          const workload = workloads.find((entry) => entry.id === artifact.workloadId);
          if (workload === undefined) continue;
          const current = artifactsByInstance.get(workload.instanceId) ?? [];
          artifactsByInstance.set(workload.instanceId, [...current, artifact]);
        }
        const candidateSecrets =
          candidate === undefined
            ? state.secrets
            : Object.fromEntries([
                ...Object.entries(state.secrets),
                ...candidate.secrets.flatMap((slot) =>
                  slot.value === undefined
                    ? []
                    : [
                        [
                          slot.slot,
                          { policy: slot.policy, value: String(Redacted.value(slot.value)) },
                        ] as const,
                      ],
                ),
              ]);
        const preparedInstances: PrepareStackInstance[] = [];
        for (const id of uniqueRequested) {
          const instance = candidateRegistry.instances.find((entry) => entry.id === id);
          if (instance === undefined) continue;
          const instanceArtifacts = artifactsByInstance.get(id) ?? [];
          preparedInstances.push({
            id,
            service: instance.service,
            artifacts: instanceArtifacts.map((artifact) => ({
              identity: `${artifact.capability}:${artifact.version}`,
              outcome: artifact.outcome,
            })),
            effectiveConfigFingerprint: yield* fingerprintEffectiveConfig(
              instance,
              candidate?.definition.security ?? state.security,
              candidateSecrets,
            ).pipe(
              Effect.provideService(Crypto.Crypto, options.crypto),
              Effect.mapError(
                (error) =>
                  new StackStateInvalidError({
                    stackId: options.id,
                    message: "Unable to fingerprint prepared service configuration",
                    cause: error,
                  }),
              ),
            ),
          });
        }
        return { instances: preparedInstances };
      }),
    ).pipe(Effect.mapError(directPrepareError));
  const readLogs = (query?: LogQuery) =>
    ensureOffline().pipe(
      Effect.andThen(
        resolveStackPaths({ stateRoot: options.environment.stateRoot, stackId: options.id }),
      ),
      Effect.provideService(Path.Path, options.path),
      Effect.flatMap((paths) =>
        readRetainedLogs(
          options.fileSystem,
          paths.logs,
          query?.cursor === undefined || query.cursor.opaque === EMPTY_LOG_CURSOR.opaque
            ? undefined
            : { cursor: query.cursor },
        ).pipe(
          Effect.map((scanned) => {
            const selected = selectLogBatch(scanned, query);
            return {
              ...selected,
              running: false,
            } satisfies StackLogBatch;
          }),
        ),
      ),
      Effect.mapError((error) =>
        error instanceof StackOwnershipConflictError || error instanceof InvalidLogCursorError
          ? error
          : new StackStateInvalidError({ message: error.message, cause: error }),
      ),
    );
  const waitForRelease = (ownerSessionId?: string) =>
    waitForOwnerRelease(
      options.environment.stateRoot,
      options.id,
      options.environment,
      ownerSessionId,
    ).pipe(
      Effect.mapError(
        (error) => new StackOwnershipConflictError({ message: error.message, cause: error }),
      ),
      Effect.provideService(FileSystem.FileSystem, options.fileSystem),
      Effect.provideService(Path.Path, options.path),
      Effect.provideService(Crypto.Crypto, options.crypto),
    );
  const fingerprintCreationInputsForRequest = (serviceOptions: unknown) =>
    Schema.decodeUnknownEffect(EffectCreateServiceOptionsSchema)(serviceOptions, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new InvalidStackConfigError({
            stackId: options.id,
            message: `Invalid service creation request: ${String(error)}`,
            cause: error,
          }),
      ),
      Effect.flatMap((normalized) =>
        fingerprintCreationInputs(normalized).pipe(
          Effect.provideService(Crypto.Crypto, options.crypto),
          Effect.mapError(
            (error) =>
              new InvalidStackConfigError({
                stackId: options.id,
                message: `Unable to fingerprint service creation request: ${error.message}`,
                cause: error,
              }),
          ),
        ),
      ),
    );
  return {
    resolveOwner,
    readOfflineState,
    readPersistedState,
    readLogs,
    waitForRelease,
    prepare,
    fingerprintCreationInputs: fingerprintCreationInputsForRequest,
  };
};

export const createStack = (
  options: CreateStackOptions,
): Effect.Effect<
  EffectStack,
  CreateStackError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawnerService
> =>
  Effect.gen(function* () {
    const env = yield* environment();
    const identity = yield* resolveStackIdentity({
      projectRoot: options.projectRoot,
      name: options.name,
    });
    const stackId = yield* deriveStackId(identity);
    const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
    // Concurrent initial writes may expose temporary files before state.json is published.
    const persisted = yield* withRegistryLock(
      env.stateRoot,
      store
        .read(stackId)
        .pipe(
          Effect.catch((error) =>
            isMissingStateRemnantError(error)
              ? Effect.map(Effect.void, () => undefined)
              : Effect.fail(error),
          ),
        ),
    );
    const resolverOption = yield* Effect.serviceOption(ContainerEngineResolver).pipe(
      Effect.map(Option.getOrUndefined),
    );
    let dockerFallbackNotice: string | undefined;
    let requestedRuntime: StackRuntime;
    if (options.runtime?.kind === "container") {
      requestedRuntime = { kind: "container", engine: options.runtime.engine ?? "docker" };
    } else if (options.runtime?.kind === "native") {
      requestedRuntime = { kind: "native" };
    } else if (persisted !== undefined) {
      requestedRuntime = persisted.runtime;
    } else {
      const selected = yield* selectDefaultRuntimeSelection(resolverOption);
      requestedRuntime = selected.runtime;
      dockerFallbackNotice = selected.dockerFallbackNotice;
    }
    if (
      persisted === undefined &&
      requestedRuntime.kind === "native" &&
      nativeRuntimeBlockedForUid()
    )
      return yield* new StackRuntimeError({ message: NATIVE_ROOT_UNSUPPORTED_MESSAGE });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const seeded =
      persisted === undefined
        ? yield* compileStack({
            projectRoot: identity.projectRoot,
            runtime: requestedRuntime,
            config: options.initialConfig,
          }).pipe(
            Effect.flatMap((compiled) =>
              seedServiceRegistry(
                compiled.definition,
                { projectRoot: identity.projectRoot, path, runtime: requestedRuntime },
                compiled.sourceConfig,
                compiled.secrets,
              ).pipe(Effect.map((services) => ({ definition: compiled.definition, services }))),
            ),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Crypto.Crypto, crypto),
          )
        : undefined;
    const initialSecrets =
      seeded === undefined
        ? undefined
        : yield* resolveSecrets(
            { declarations: seeded.services.secretSlots },
            {},
            "unconfigured",
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(Crypto.Crypto, crypto),
          );
    const seededWithFingerprints =
      seeded === undefined || initialSecrets === undefined
        ? seeded
        : {
            ...seeded,
            services: {
              ...seeded.services,
              registry: {
                ...seeded.services.registry,
                instances: yield* Effect.forEach(seeded.services.registry.instances, (instance) =>
                  fingerprintBootstrapInputs(
                    instance,
                    seeded.definition.security,
                    initialSecrets.persisted,
                  ).pipe(
                    Effect.provideService(Crypto.Crypto, crypto),
                    Effect.map((bootstrapInputsId) =>
                      bootstrapInputsId === undefined
                        ? instance
                        : { ...instance, bootstrapInputsId },
                    ),
                  ),
                ),
              },
            },
          };
    const initialState = stateInitial(
      identity,
      requestedRuntime,
      seededWithFingerprints,
      initialSecrets?.persisted,
    );
    const plannedInitialState =
      seededWithFingerprints === undefined
        ? initialState
        : yield* Effect.reduce(
            initialState.registry.instances,
            () => initialState,
            (state, instance) =>
              plannedInstancePorts(state, instance).pipe(
                Effect.map((ports) => ({ ...state, ...ports })),
              ),
          );
    const current = yield* store.initialize(stackId, plannedInitialState);
    const runtimeMismatch =
      options.runtime !== undefined &&
      (current.runtime.kind !== requestedRuntime.kind ||
        (requestedRuntime.kind === "container" &&
          current.runtime.kind === "container" &&
          current.runtime.engine !== requestedRuntime.engine));
    if (runtimeMismatch)
      return yield* new StackRuntimeMismatchError({
        message: "Stack runtime is immutable for an existing identity",
      });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const dependencies = handleDependencies({
      environment: env,
      store,
      id: stackId,
      fileSystem: fs,
      path,
      crypto,
      spawner,
      containerEngineResolver: resolverOption,
    });
    const handle = yield* makeHandle(stackId, dependencies);
    return dockerFallbackNotice === undefined ? handle : { ...handle, dockerFallbackNotice };
  }).pipe(Effect.mapError(createError));

export const openStack = (
  id: StackId,
  _options?: OpenStackOptions,
): Effect.Effect<
  EffectStack,
  OpenStackError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawnerService
> =>
  Effect.gen(function* () {
    const env = yield* environment();
    const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
    const state = yield* store.read(id);
    if (state === undefined)
      return yield* new StackNotFoundError({ stackId: id, message: "Stack state was not found" });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const containerEngineResolver = yield* Effect.serviceOption(ContainerEngineResolver).pipe(
      Effect.map(Option.getOrUndefined),
    );
    const dependencies = handleDependencies({
      environment: env,
      store,
      id,
      fileSystem: fs,
      path,
      crypto,
      spawner,
      containerEngineResolver,
    });
    return yield* makeHandle(id, dependencies);
  });

export const findStack = (
  options: FindStackOptions,
): Effect.Effect<
  Option.Option<StackDescriptor>,
  StackDiscoveryError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const env = yield* environment();
    const identity = yield* resolveStackIdentity({
      projectRoot: options.projectRoot,
      name: options.name,
    });
    const id = yield* deriveStackId(identity);
    const state = yield* (yield* makeStackStateStore({ stateRoot: env.stateRoot })).read(id);
    return state === undefined ? Option.none() : Option.some(descriptor(state, id));
  });

export interface StackDiscoveryIssue {
  readonly id: StackId;
  readonly error: StackDiscoveryError;
}

/** The managed stack registry with entry-level read errors retained for bulk operations. */
export interface StackDiscoveryResult {
  readonly stacks: ReadonlyArray<StackDescriptor>;
  readonly errors: ReadonlyArray<StackDiscoveryIssue>;
}

const enrichStackDiscoveryError = (
  entry: StackId,
  error: Effect.Error<ReturnType<StackStateStore["read"]>>,
): StackDiscoveryError => {
  const message = `Failed to read managed stack ${entry}: ${error.message}`;
  return Match.value(error).pipe(
    Match.tag(
      "InvalidProjectRootError",
      (value) => new InvalidProjectRootError({ ...value, message, cause: error }),
    ),
    Match.tag(
      "StackStateInvalidError",
      (value) => new StackStateInvalidError({ ...value, stackId: entry, message, cause: error }),
    ),
    Match.tag(
      "StackStateFormatUnsupportedError",
      (value) => new StackStateFormatUnsupportedError({ ...value, message, cause: error }),
    ),
    Match.exhaustive,
  );
};

export const discoverStacks = (
  options: ListStacksOptions = {},
): Effect.Effect<
  StackDiscoveryResult,
  StackDiscoveryError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const env = yield* environment();
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
    const projectRoot =
      options.projectRoot === undefined
        ? undefined
        : yield* fs
            .realPath(options.projectRoot)
            .pipe(
              Effect.mapError((error) => new InvalidProjectRootError({ message: error.message })),
            );
    if (
      !(yield* fs
        .exists(env.stateRoot)
        .pipe(Effect.mapError((error) => new StackStateInvalidError({ message: error.message }))))
    )
      return { stacks: [], errors: [] };
    const entries = yield* fs
      .readDirectory(env.stateRoot)
      .pipe(Effect.mapError((error) => new StackStateInvalidError({ message: error.message })));
    const stacks: StackDescriptor[] = [];
    const errors: StackDiscoveryIssue[] = [];
    for (const entry of entries) {
      if (!Schema.is(StackIdSchema)(entry)) continue;
      const result = yield* store.read(entry).pipe(
        Effect.catchTag("StackStateInvalidError", (error) =>
          isMissingStateRemnantError(error) ? Effect.void : Effect.fail(error),
        ),
        Effect.result,
      );
      if (Result.isFailure(result)) {
        errors.push({ id: entry, error: enrichStackDiscoveryError(entry, result.failure) });
        continue;
      }
      const state = result.success;
      if (
        state !== undefined &&
        (projectRoot === undefined || state.identity.projectRoot === projectRoot)
      )
        stacks.push(descriptor(state, entry));
    }
    return { stacks, errors };
  });

type ConfigDrift = NonNullable<StackInspection["configDrift"]>;

const secretDriftPaths = (
  candidate: ReadonlyArray<SecretSlotInput>,
  persisted: PersistedStackState["secrets"],
): ReadonlyArray<string> => {
  const paths: string[] = [];
  const supplied = new Map(candidate.map((entry) => [entry.slot, entry]));
  for (const entry of candidate) {
    const old = persisted[entry.slot];
    if (old === undefined) {
      if (entry.policy === "passthrough" || entry.value !== undefined)
        paths.push(`secrets.${entry.slot}`);
      continue;
    }
    if (old.policy !== entry.policy) {
      paths.push(`secrets.${entry.slot}`);
      continue;
    }
    if (entry.policy === "passthrough" || entry.value !== undefined) {
      const value = entry.value === undefined ? undefined : Redacted.value(entry.value);
      if (value !== old.value) paths.push(`secrets.${entry.slot}`);
    }
  }
  for (const [slot, old] of Object.entries(persisted)) {
    if (old.policy === "passthrough" && !supplied.has(slot)) paths.push(`secrets.${slot}`);
  }
  return paths;
};

const inspectConfigDrift = (
  state: PersistedStackState,
  config: StackConfig,
): Effect.Effect<ConfigDrift, InvalidStackConfigError | StackVersionUnsupportedError, Path.Path> =>
  Effect.gen(function* () {
    const compiled = yield* compileStack({
      projectRoot: state.identity.projectRoot,
      runtime: state.runtime,
      config,
      registry: state.registry,
    });
    const candidate = yield* prospectiveRegistry(state, compiled.definition);
    const paths: string[] = [];
    const currentDefaults = state.registry.instances.filter(
      (instance) => state.registry.defaultInstanceIds[instance.service] === instance.id,
    );
    const candidateDefaults = candidate.instances.filter(
      (instance) => candidate.defaultInstanceIds[instance.service] === instance.id,
    );
    if (
      canonical(
        currentDefaults.map((instance) => ({
          service: instance.service,
          config: resolvedStateValue(instance.config, state.secrets),
        })),
      ) !==
      canonical(
        candidateDefaults.map((instance) => ({
          service: instance.service,
          config: resolvedStateValue(instance.config, state.secrets),
        })),
      )
    )
      paths.push("services");
    if (canonical(state.security) !== canonical(compiled.definition.security))
      paths.push("security.jwt");
    paths.push(...secretDriftPaths(compiled.secrets, state.secrets));
    const uniquePaths = [...new Set(paths)].sort();
    return {
      status: uniquePaths.length === 0 ? "unchanged" : "changed",
      paths: uniquePaths,
    } satisfies ConfigDrift;
  });

export const listStacks = (
  options: ListStacksOptions = {},
): Effect.Effect<
  ReadonlyArray<StackDescriptor>,
  StackDiscoveryError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  discoverStacks(options).pipe(
    Effect.flatMap(({ stacks, errors }) => {
      const firstError = errors[0];
      return firstError === undefined ? Effect.succeed(stacks) : Effect.fail(firstError.error);
    }),
  );

export const inspectStack = (
  id: StackId,
  options: InspectStackOptions = {},
): Effect.Effect<
  StackInspection,
  StackNotFoundError | StackDiscoveryError | InvalidStackConfigError | StackVersionUnsupportedError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const env = yield* environment();
    const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
    const state = yield* store.read(id);
    if (state === undefined)
      return yield* new StackNotFoundError({ stackId: id, message: "Stack state was not found" });
    const configDrift =
      options.config === undefined ? undefined : yield* inspectConfigDrift(state, options.config);
    const metadata = yield* readOwnerMetadata(env.stateRoot, id, env);
    if (metadata === undefined)
      return {
        descriptor: descriptor(state, id),
        owner: (yield* ownerLockExists(env.stateRoot, id)) ? "unreachable" : "absent",
        ...(configDrift === undefined ? {} : { configDrift }),
      };
    if (metadata.rpcRelease !== STACK_RPC_RELEASE)
      return {
        descriptor: descriptor(state, id),
        owner: "incompatible",
        ...(configDrift === undefined ? {} : { configDrift }),
      };
    const status = yield* Effect.scoped(
      Effect.gen(function* () {
        const client = makeControlClient(metadata.endpoint, {
          stackId: id,
          ownerSessionId: metadata.ownerSessionId,
        });
        const rpc = yield* client.rpc;
        return yield* rpc.status(undefined);
      }),
    ).pipe(Effect.exit);
    if (Exit.isFailure(status)) {
      const failure = Cause.findErrorOption(status.cause);
      if (Option.isSome(failure) && isOwnerUnreachable(failure.value))
        return {
          descriptor: descriptor(state, id),
          owner: "unreachable",
          ...(configDrift === undefined ? {} : { configDrift }),
        };
      return {
        descriptor: descriptor(state, id),
        owner: "running",
        ...(configDrift === undefined ? {} : { configDrift }),
      };
    }
    return {
      descriptor: descriptor(state, id),
      owner: "running",
      status: status.value,
      ...(configDrift === undefined ? {} : { configDrift }),
    };
  });
