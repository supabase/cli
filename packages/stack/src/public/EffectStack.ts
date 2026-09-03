import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Predicate,
  Schedule,
  Scope,
  Schema,
  Stream,
} from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { SocketError } from "effect/unstable/socket/Socket";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
import type { StackIdentity } from "../identity/Identity.ts";
import { resolveStackIdentity, deriveStackId } from "../identity/Identity.ts";
import { compileStack, rebuildExecutionPlan, type StackDefinition } from "../model/Compiler.ts";
import type { ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { PersistedStackIdentity, PersistedStackState } from "../state/StackState.ts";
import { toPersistedIdentity } from "../state/StackState.ts";
import { makeStackStateStore, type StackStateStore } from "../state/StackStateStore.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { StackIdSchema, type StackId } from "./StackId.ts";
import type { StackRuntime, StackRuntimePreference } from "./Runtime.ts";
import type { StackConfig } from "./Config.ts";
import { type StackStatus, type StackDescriptor, type StackInspection } from "./Status.ts";
import { CAPABILITY_NAMES, type CapabilityName } from "./Capability.ts";
import type { LogQuery, StackLogBatch, StackLogEntry } from "./Logs.ts";
import type { EffectStackCredentials } from "./Credentials.ts";
import {
  InvalidStackIdentityError,
  InvalidProjectRootError,
  InvalidStackConfigError,
  StackVersionUnsupportedError,
  StackDefinitionRequiredError,
  StackDestructionError,
  StackNotFoundError,
  StackNotRunningError,
  StackOwnershipConflictError,
  StackRuntimeMismatchError,
  StackLifecycleConflictError,
  StackPreparationError,
  ArtifactIntegrityError,
  ContainerPullError,
  StackSecretMismatchError,
  InvalidJwtSigningMaterialError,
  StackReconciliationError,
  ServiceStartError,
  ServiceReadinessError,
  ContainerEngineError,
  StackStateInvalidError,
  StackStateFormatUnsupportedError,
  StackUpgradeRequiredError,
  StackMustBeStoppedError,
  PortAllocationError,
  PortUnavailableError,
  GatewayAuthenticationError,
  GatewayActivationError,
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
  isStackErrorTag,
} from "./Errors.ts";
import {
  ownerLockExists,
  readOwnerMetadata,
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
  type ContainerEngineResolverShape,
} from "../runtime/ContainerEngineResolver.ts";
import {
  ContainerEngineProtocolError,
  makeProcessCommandRunner,
  type ContainerEngineKind,
  type ContainerPlatform,
  type ContainerEngine,
} from "../runtime/ContainerEngine.ts";
import { statusFor } from "../supervisor/StatusProjection.ts";
import { makeDockerEngine } from "../runtime/DockerEngine.ts";
import { makePodmanEngine } from "../runtime/PodmanEngine.ts";
import { readRetainedLogs } from "../supervisor/LogStore.ts";
import {
  makeProductionRuntimeArtifactPreparer,
  type PreparedWorkloadArtifact,
} from "../preparation/RuntimeArtifacts.ts";

export interface StartStackOptions {
  readonly config?: StackConfig;
}
export interface PrepareStackOptions {
  readonly config?: StackConfig;
  readonly capabilities?: ReadonlyArray<CapabilityName>;
}
export interface CreateStackOptions {
  readonly projectRoot: string;
  readonly name?: string;
  readonly runtime?: StackRuntimePreference;
}
export interface FindStackOptions {
  readonly projectRoot: string;
  readonly name?: string;
}
export interface ListStacksOptions {
  readonly projectRoot?: string;
}
export interface PreparedCapability {
  readonly capability: CapabilityName;
  readonly version: string;
  readonly outcome: "cached" | "downloaded" | "pulled";
}
export interface PrepareStackResult {
  readonly capabilities: ReadonlyArray<PreparedCapability>;
}

export interface EffectStack {
  readonly id: StackId;
  // These methods intentionally create a fresh scoped RPC invocation per call.
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly status: () => Effect.Effect<StackStatus, StackStatusError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly credentials: () => Effect.Effect<EffectStackCredentials, StackCredentialsError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly prepare: (
    options?: PrepareStackOptions,
  ) => Effect.Effect<PrepareStackResult, PrepareStackError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly start: (options?: StartStackOptions) => Effect.Effect<StackStatus, StackStartError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly stop: () => Effect.Effect<void, StackStopError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly destroy: () => Effect.Effect<void, DestroyStackError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly logs: (query?: LogQuery) => Effect.Effect<StackLogBatch, StackLogsError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly followLogs: (query?: LogQuery) => Stream.Stream<StackLogEntry, StackLogsError>;
}

const optionOf = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none() : Option.some(value);

const defaultContainerPlatform = (): ContainerPlatform => {
  // Host details are read only at this composition boundary. The real
  // container adapters reject unsupported Podman routing during preflight.
  if (process.platform === "darwin") return { os: "darwin", desktop: true };
  if (process.platform === "win32") return { os: "windows", desktop: true };
  return { os: "linux", desktop: false };
};

const defaultContainerEngineResolver = (): ContainerEngineResolverShape => ({
  resolve: (kind) =>
    Effect.gen(function* () {
      const platform = defaultContainerPlatform();
      const runner = yield* makeProcessCommandRunner({ executable: kind });
      return kind === "docker"
        ? makeDockerEngine({ runner, platform })
        : makePodmanEngine({ runner, platform });
    }),
});

const resolveContainerEngine = (
  kind: ContainerEngineKind,
  resolver: ContainerEngineResolverShape | undefined,
  spawner: ChildProcessSpawnerValue,
): Effect.Effect<ContainerEngine, ContainerEngineError> =>
  (resolver ?? defaultContainerEngineResolver()).resolve(kind).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.mapError(
      (error) =>
        new ContainerEngineError({
          message:
            error instanceof ContainerEngineProtocolError
              ? `${error.operation}: ${error.message}`
              : error.message,
        }),
    ),
  );

const descriptor = (state: PersistedStackState): StackDescriptor => ({
  id: StackIdSchema.make(state.identity.stackId),
  projectRoot: state.identity.projectRoot,
  name: state.identity.stackName,
  branchContext: state.identity.branchContext,
  runtime: state.runtime,
  desiredLifecycle: state.desiredLifecycle,
});

const environment = () =>
  Effect.serviceOption(StackRuntimeEnvironment).pipe(
    Effect.map(Option.getOrElse(defaultRuntimeEnvironment)),
  );

type ControlError =
  | StackRpcError
  | RpcClientError
  | SocketError
  | MaintenanceProtocolError
  | StackError;

const stackErrorFactories = {
  InvalidStackIdentityError: (message: string) => new InvalidStackIdentityError({ message }),
  InvalidProjectRootError: (message: string) => new InvalidProjectRootError({ message }),
  InvalidStackConfigError: (message: string) => new InvalidStackConfigError({ message }),
  StackVersionUnsupportedError: (message: string) => new StackVersionUnsupportedError({ message }),
  StackNotFoundError: (message: string) => new StackNotFoundError({ message }),
  StackOwnershipConflictError: (message: string) => new StackOwnershipConflictError({ message }),
  StackRuntimeMismatchError: (message: string) => new StackRuntimeMismatchError({ message }),
  StackDefinitionRequiredError: (message: string) => new StackDefinitionRequiredError({ message }),
  StackNotRunningError: (message: string) => new StackNotRunningError({ message }),
  StackMustBeStoppedError: (message: string) => new StackMustBeStoppedError({ message }),
  StackLifecycleConflictError: (message: string) => new StackLifecycleConflictError({ message }),
  StackStateInvalidError: (message: string) => new StackStateInvalidError({ message }),
  StackStateFormatUnsupportedError: (message: string) =>
    new StackStateFormatUnsupportedError({ message }),
  StackUpgradeRequiredError: (message: string) => new StackUpgradeRequiredError({ message }),
  StackSecretMismatchError: (message: string) => new StackSecretMismatchError({ message }),
  InvalidJwtSigningMaterialError: (message: string) =>
    new InvalidJwtSigningMaterialError({ message }),
  PortAllocationError: (message: string) => new PortAllocationError({ message }),
  PortUnavailableError: (message: string) => new PortUnavailableError({ message }),
  GatewayAuthenticationError: (message: string) => new GatewayAuthenticationError({ message }),
  GatewayActivationError: (message: string) => new GatewayActivationError({ message }),
  StackPreparationError: (message: string) => new StackPreparationError({ message }),
  ArtifactIntegrityError: (message: string) => new ArtifactIntegrityError({ message }),
  ContainerPullError: (message: string) => new ContainerPullError({ message }),
  StackReconciliationError: (message: string) => new StackReconciliationError({ message }),
  ServiceStartError: (message: string) => new ServiceStartError({ message }),
  ServiceReadinessError: (message: string) => new ServiceReadinessError({ message }),
  ContainerEngineError: (message: string) => new ContainerEngineError({ message }),
  StackDestructionError: (message: string) => new StackDestructionError({ message }),
} satisfies Record<StackErrorTag, (message: string) => StackError>;

const errorForRpc = (error: ControlError): StackError => {
  if (
    Predicate.isTagged(error, "StackOwnershipConflictError") ||
    Predicate.isTagged(error, "StackLifecycleConflictError") ||
    Predicate.isTagged(error, "StackStateInvalidError") ||
    Predicate.isTagged(error, "StackStateFormatUnsupportedError") ||
    Predicate.isTagged(error, "StackUpgradeRequiredError")
  )
    return error;
  if (
    Predicate.isTagged(error, "RpcClientError") ||
    Predicate.isTagged(error, "SocketError") ||
    isMaintenanceTransportFailure(error)
  )
    return new StackOwnershipConflictError({
      message: `Stack owner is unreachable: ${error.message}`,
    });
  if (
    typeof error === "object" &&
    error !== null &&
    "tag" in error &&
    "message" in error &&
    typeof error.tag === "string" &&
    typeof error.message === "string"
  ) {
    if (isStackErrorTag(error.tag)) return stackErrorFactories[error.tag](error.message);
    if (error.tag === "StackRpcProtocolError")
      return new StackUpgradeRequiredError({ message: error.message });
    return new StackStateInvalidError({ message: error.message });
  }
  return new StackStateInvalidError({ message: error.message });
};

const statusError = (error: ControlError): StackStatusError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackNotFoundError ||
    mapped instanceof StackOwnershipConflictError ||
    mapped instanceof StackStateInvalidError ||
    mapped instanceof StackStateFormatUnsupportedError ||
    mapped instanceof StackUpgradeRequiredError
    ? mapped
    : new StackStateInvalidError({ message: mapped.message });
};

const credentialsError = (error: ControlError): StackCredentialsError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackNotFoundError ||
    mapped instanceof StackNotRunningError ||
    mapped instanceof StackOwnershipConflictError ||
    mapped instanceof StackSecretMismatchError ||
    mapped instanceof InvalidJwtSigningMaterialError
    ? mapped
    : new StackNotRunningError({ message: mapped.message });
};

const startError = (error: ControlError): StackStartError => {
  const mapped = errorForRpc(error);
  return mapped instanceof InvalidStackConfigError ||
    mapped instanceof StackDefinitionRequiredError ||
    mapped instanceof StackVersionUnsupportedError ||
    mapped instanceof StackNotRunningError ||
    mapped instanceof StackMustBeStoppedError ||
    mapped instanceof StackLifecycleConflictError ||
    mapped instanceof StackStateInvalidError ||
    mapped instanceof StackStateFormatUnsupportedError ||
    mapped instanceof StackUpgradeRequiredError ||
    mapped instanceof StackSecretMismatchError ||
    mapped instanceof InvalidJwtSigningMaterialError ||
    mapped instanceof PortAllocationError ||
    mapped instanceof PortUnavailableError ||
    mapped instanceof StackPreparationError ||
    mapped instanceof ArtifactIntegrityError ||
    mapped instanceof ContainerPullError ||
    mapped instanceof StackReconciliationError ||
    mapped instanceof ServiceStartError ||
    mapped instanceof ServiceReadinessError ||
    mapped instanceof ContainerEngineError ||
    mapped instanceof StackOwnershipConflictError
    ? mapped
    : new StackStateInvalidError({ message: mapped.message });
};

const stopError = (error: ControlError): StackStopError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackOwnershipConflictError ||
    mapped instanceof StackLifecycleConflictError
    ? mapped
    : new StackLifecycleConflictError({ message: mapped.message });
};

const logsError = (error: ControlError): StackLogsError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackNotFoundError ||
    mapped instanceof StackNotRunningError ||
    mapped instanceof StackStateInvalidError ||
    mapped instanceof StackOwnershipConflictError ||
    mapped instanceof StackLifecycleConflictError
    ? mapped
    : new StackStateInvalidError({ message: mapped.message });
};

const destroyError = (error: ControlError): DestroyStackError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackDestructionError ||
    mapped instanceof StackNotFoundError ||
    mapped instanceof StackOwnershipConflictError ||
    mapped instanceof StackLifecycleConflictError ||
    mapped instanceof ContainerEngineError
    ? mapped
    : new StackDestructionError({ message: mapped.message });
};

/** Internal control-transport seam used by public lifecycle integration tests. */
export const makeHandle = (
  id: StackId,
  metadata: {
    readonly endpoint?: Parameters<typeof makeControlClient>[0];
    readonly ownerSessionId?: string;
    readonly rpcRelease?: string;
  },
  options: {
    readonly resolveOwner?: (
      launch: boolean,
    ) => Effect.Effect<Option.Option<OwnerMetadata>, StackError>;
    readonly readOfflineState?: () => Effect.Effect<Option.Option<PersistedStackState>, StackError>;
    readonly readPersistedState?: () => Effect.Effect<
      Option.Option<PersistedStackState>,
      StackError
    >;
    readonly readLogs?: (query?: LogQuery) => Effect.Effect<StackLogBatch, StackLogsError>;
    readonly waitForRelease?: () => Effect.Effect<void, StackStopError>;
    readonly prepare?: (
      options?: PrepareStackOptions,
    ) => Effect.Effect<PrepareStackResult, PrepareStackError>;
    readonly containerEngineResolver?: ContainerEngineResolverShape;
  } = {},
): Effect.Effect<EffectStack> =>
  Effect.sync(() => {
    const readOfflineState = options.readOfflineState;
    const readPersistedState = options.readPersistedState;
    const readLogs = options.readLogs;
    const client: ReturnType<typeof makeControlClient> | undefined =
      metadata.endpoint !== undefined &&
      metadata.ownerSessionId !== undefined &&
      metadata.rpcRelease !== undefined
        ? makeControlClient(metadata.endpoint, {
            stackId: id,
            ownerSessionId: metadata.ownerSessionId,
            rpcRelease: metadata.rpcRelease,
          })
        : undefined;
    const resolveClient = (
      launch: boolean,
    ): Effect.Effect<ReturnType<typeof makeControlClient>, StackError> =>
      options.resolveOwner !== undefined
        ? options.resolveOwner(launch).pipe(
            Effect.flatMap((owner) =>
              Option.isSome(owner)
                ? Effect.succeed(
                    makeControlClient(owner.value.endpoint, {
                      stackId: id,
                      ownerSessionId: owner.value.ownerSessionId,
                      rpcRelease: owner.value.rpcRelease,
                    }),
                  )
                : Effect.fail(
                    new StackOwnershipConflictError({ message: "No Supervisor owns this stack" }),
                  ),
            ),
          )
        : client !== undefined
          ? Effect.succeed(client)
          : Effect.fail(
              new StackOwnershipConflictError({ message: "No Supervisor owns this stack" }),
            );
    const mapRpcClientFailure = <E extends StackError>(
      error: RpcClientError,
      mapError: (error: ControlError) => E,
    ): Effect.Effect<never, E> =>
      Effect.exit(resolveClient(false).pipe(Effect.flatMap((owner) => owner.probe()))).pipe(
        Effect.flatMap((probe) => {
          if (
            Exit.isSuccess(probe) &&
            probe.value.ok &&
            probe.value.op === "probe" &&
            probe.value.rpcRelease !== STACK_RPC_RELEASE
          ) {
            const mismatch: StackRpcError = {
              tag: "StackRpcProtocolError",
              message: `Stack owner release ${probe.value.rpcRelease} requires stop before start`,
            };
            return Effect.fail(mapError(mismatch));
          }
          return Effect.fail(mapError(error));
        }),
      );
    const invoke = <A, E extends StackError>(
      call: (rpc: StackRpcClient) => Effect.Effect<A, StackRpcError | RpcClientError>,
      mapError: (error: ControlError) => E,
      launch = false,
    ): Effect.Effect<A, E> => {
      const rpcCall: Effect.Effect<A, StackRpcError | RpcClientError | StackError> = resolveClient(
        launch,
      ).pipe(Effect.flatMap((owner) => Effect.scoped(owner.rpc.pipe(Effect.flatMap(call)))));
      const mapped: Effect.Effect<A, E> = rpcCall.pipe(
        Effect.catchIf(
          (error): error is RpcClientError => Predicate.isTagged(error, "RpcClientError"),
          (error) => mapRpcClientFailure(error, mapError),
          (error) => Effect.fail(mapError(error)),
        ),
      );
      return mapped;
    };
    const destroyAndAwaitOwner: Effect.Effect<void, DestroyStackError> = resolveClient(true).pipe(
      Effect.mapError(destroyError),
      Effect.flatMap((client) =>
        Effect.gen(function* () {
          const ownerConnected = yield* Deferred.make<void>();
          const ownerWatch = client.awaitClose(
            Deferred.succeed(ownerConnected, undefined).pipe(Effect.asVoid),
          );
          const ownerFiber = yield* Effect.forkChild(ownerWatch, { startImmediately: true });
          const ownerReady = Deferred.await(ownerConnected).pipe(
            Effect.raceFirst(
              Fiber.join(ownerFiber).pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new StackDestructionError({
                      message: "Unable to observe Supervisor control connection",
                    }),
                  ),
                ),
                Effect.mapError(
                  (cause) =>
                    new StackDestructionError({
                      message: "Unable to observe Supervisor control connection",
                      cause,
                    }),
                ),
              ),
            ),
          );
          const result = yield* Effect.exit(
            ownerReady.pipe(
              Effect.andThen(invoke((rpc) => rpc.destroy(undefined), destroyError)),
              // The owner closes its control server only after all workload cleanup has completed.
              // Await the exact preface-only socket instead of decoding a terminal RPC stream Exit.
              Effect.andThen(
                Fiber.join(ownerFiber).pipe(
                  Effect.mapError(
                    (cause) =>
                      new StackDestructionError({
                        message: "Unable to observe Supervisor shutdown completion",
                        cause,
                      }),
                  ),
                ),
              ),
            ),
          );
          if (Exit.isFailure(result)) {
            yield* Fiber.interrupt(ownerFiber);
          }
          return yield* result;
        }),
      ),
    );
    const status = () => {
      const rpcStatus = invoke((rpc) => rpc.status(undefined), statusError);
      if (readOfflineState === undefined) return rpcStatus;
      return rpcStatus.pipe(
        Effect.catchTag("StackOwnershipConflictError", () =>
          readOfflineState().pipe(
            Effect.mapError(statusError),
            Effect.flatMap((state) =>
              Option.isSome(state) &&
              (state.value.desiredLifecycle === "stopped" ||
                state.value.desiredLifecycle === "unconfigured")
                ? statusFor(state.value, [], new Set<CapabilityName>(), "stopped").pipe(
                    Effect.mapError(statusError),
                  )
                : Effect.fail(
                    new StackOwnershipConflictError({ message: "No Supervisor owns this stack" }),
                  ),
            ),
          ),
        ),
      );
    };
    const start = (options?: StartStackOptions) =>
      invoke(
        (rpc) =>
          options?.config === undefined ? rpc.start({}) : rpc.start({ config: options.config }),
        startError,
        true,
      );
    const logsStateError = (error: StackError): StackLogsError =>
      error instanceof StackOwnershipConflictError || error instanceof StackStateInvalidError
        ? error
        : new StackStateInvalidError({ message: error.message, cause: error });
    const stopOwner = (owner: ReturnType<typeof makeControlClient>) =>
      Effect.gen(function* () {
        // Subscribe to the owner control connection before sending stop so a
        // fast shutdown cannot race the close witness.
        const closeFiber = yield* Effect.forkChild(owner.awaitClose(), { startImmediately: true });
        const response = yield* owner.stop().pipe(Effect.exit);
        if (Exit.isFailure(response)) {
          yield* Fiber.interrupt(closeFiber);
          return yield* Effect.failCause(response.cause);
        }
        if (!response.value.ok) {
          yield* Fiber.interrupt(closeFiber);
          return yield* new StackLifecycleConflictError({ message: response.value.error.message });
        }
        yield* Fiber.join(closeFiber).pipe(Effect.ignore);
        if (options.waitForRelease !== undefined) yield* options.waitForRelease();
      }).pipe(Effect.mapError(stopError));
    const stop = () =>
      resolveClient(false).pipe(
        Effect.mapError(stopError),
        Effect.flatMap(stopOwner),
        Effect.catchTag("StackOwnershipConflictError", () =>
          (readOfflineState === undefined
            ? Effect.fail(
                new StackOwnershipConflictError({ message: "No Supervisor owns this stack" }),
              )
            : readOfflineState().pipe(
                Effect.mapError(stopError),
                Effect.flatMap((state) =>
                  Option.isSome(state) &&
                  (state.value.desiredLifecycle === "stopped" ||
                    state.value.desiredLifecycle === "unconfigured")
                    ? Effect.void
                    : resolveClient(true).pipe(
                        Effect.mapError(stopError),
                        Effect.flatMap(stopOwner),
                      ),
                ),
              )
          ).pipe(
            // Ownership artifacts that block the offline fast path may be
            // stale. Let ensureSupervisor arbitrate the lease; a live owner
            // remains protected and returns a typed conflict.
            Effect.catchTag("StackOwnershipConflictError", () =>
              resolveClient(true).pipe(Effect.mapError(stopError), Effect.flatMap(stopOwner)),
            ),
          ),
        ),
      );
    const prepare = (
      prepareOptions?: PrepareStackOptions,
    ): Effect.Effect<PrepareStackResult, PrepareStackError> =>
      options.prepare === undefined
        ? Effect.fail(new StackPreparationError({ message: "Stack preparation is unavailable" }))
        : options.prepare(prepareOptions);
    const logs = (query?: LogQuery): Effect.Effect<StackLogBatch, StackLogsError> =>
      invoke((rpc) => rpc.logs(query ?? {}), logsError).pipe(
        Effect.catchTag("StackOwnershipConflictError", (ownershipError) => {
          if (readLogs === undefined)
            return Effect.fail(
              new StackOwnershipConflictError({ message: "No Supervisor owns this stack" }),
            );
          if (readOfflineState === undefined || readPersistedState === undefined)
            return Effect.fail(ownershipError);
          const ownerStopped = readPersistedState().pipe(
            Effect.map(
              (state) =>
                Option.isSome(state) &&
                (state.value.desiredLifecycle === "stopped" ||
                  state.value.desiredLifecycle === "unconfigured"),
            ),
            Effect.mapError(logsStateError),
          );
          return ownerStopped.pipe(
            Effect.flatMap((teardown) => {
              if (!teardown) return Effect.fail(ownershipError);
              return Effect.suspend(() =>
                // During an owner stop the control socket can close before its metadata/lease are
                // released. Re-check ownership before each read and retry only that typed
                // transition; a live owner or other log failure remains visible.
                readOfflineState().pipe(
                  Effect.mapError(logsStateError),
                  Effect.andThen(readLogs(query)),
                ),
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
      status,
      credentials: () => invoke((rpc) => rpc.credentials(undefined), credentialsError),
      prepare,
      start,
      stop,
      destroy: () => destroyAndAwaitOwner,
      logs,
      followLogs: (query) =>
        Stream.paginate({ cursor: query?.cursor, first: true }, ({ cursor, first }) => {
          const { cursor: _initialCursor, tail: _tail, ...baseQuery } = query ?? {};
          const options = {
            ...baseQuery,
            ...(first && query?.tail !== undefined ? { tail: query.tail } : {}),
            ...(cursor === undefined || cursor.opaque === "v1_0" ? {} : { cursor }),
          };
          const request = logs(options);
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
  stackId: StackId,
  runtime: StackRuntime,
): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: toPersistedIdentity(identity, stackId),
  runtime,
  desiredLifecycle: "unconfigured",
  ports: [],
  privatePorts: [],
  secrets: {},
});

const runtimeIdentity = (identity: PersistedStackIdentity): StackIdentity => {
  const { stackId: _stackId, ...value } = identity;
  return value;
};

type ChildProcessSpawnerValue = Context.Service.Shape<
  typeof ChildProcessSpawner.ChildProcessSpawner
>;

const handleDependencies = (options: {
  readonly environment: StackRuntimeEnvironmentValue;
  readonly store: StackStateStore;
  readonly id: StackId;
  readonly identity: StackIdentity;
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
    provide(readOwnerMetadata(options.environment.stateRoot, options.id, options.environment)).pipe(
      Effect.flatMap((owner) =>
        launch
          ? Effect.scoped(
              ensureSupervisor({
                identity: options.identity,
                stackId: options.id,
                stateStore: options.store,
                environment: options.environment,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, options.fileSystem),
                Effect.provideService(Path.Path, options.path),
                Effect.provideService(Crypto.Crypto, options.crypto),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
              ),
            ).pipe(Effect.map(Option.some))
          : owner !== undefined
            ? Effect.succeed(Option.some(owner))
            : Effect.succeed(Option.none()),
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
  const readOfflineState = () =>
    ensureOffline().pipe(
      Effect.andThen(provide(options.store.read(options.id))),
      Effect.map(optionOf),
    );
  const readPersistedState = () =>
    provide(options.store.read(options.id)).pipe(Effect.map(optionOf));
  const directPrepareError = (cause: unknown): PrepareStackError =>
    cause instanceof StackPreparationError ||
    cause instanceof ArtifactIntegrityError ||
    cause instanceof ContainerPullError ||
    cause instanceof StackOwnershipConflictError ||
    cause instanceof StackStateInvalidError ||
    cause instanceof StackLifecycleConflictError
      ? cause
      : new StackPreparationError({
          stackId: options.id,
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
  const prepare = (
    prepareOptions?: PrepareStackOptions,
  ): Effect.Effect<PrepareStackResult, PrepareStackError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* options.store
          .read(options.id)
          .pipe(
            Effect.provideService(FileSystem.FileSystem, options.fileSystem),
            Effect.provideService(Path.Path, options.path),
            Effect.provideService(Crypto.Crypto, options.crypto),
            Effect.mapError(directPrepareError),
          );
        if (state === undefined)
          return yield* new StackStateInvalidError({
            stackId: options.id,
            message: "Stack state is missing",
          });
        let definition: StackDefinition;
        let plan: ExecutionPlan;
        if (prepareOptions?.config === undefined && state.definition !== undefined) {
          definition = state.definition;
          plan = yield* rebuildExecutionPlan(state.runtime, definition).pipe(
            Effect.provideService(Crypto.Crypto, options.crypto),
          );
        } else {
          const compiled = yield* compileStack({
            projectRoot: state.identity.projectRoot,
            runtime: state.runtime,
            config: prepareOptions?.config,
          }).pipe(
            Effect.provideService(Path.Path, options.path),
            Effect.provideService(Crypto.Crypto, options.crypto),
          );
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
                stackId: options.id,
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
        const containerEngine =
          state.runtime.kind === "container"
            ? yield* resolveContainerEngine(
                state.runtime.engine,
                options.containerEngineResolver,
                options.spawner,
              )
            : undefined;
        const preparer = yield* makeProductionRuntimeArtifactPreparer({
          stateRoot: options.environment.stateRoot,
          runtime: state.runtime,
          ...(containerEngine === undefined ? {} : { containerEngine }),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, options.fileSystem),
          Effect.provideService(Path.Path, options.path),
          Effect.provideService(Crypto.Crypto, options.crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
        );
        const artifacts = yield* Effect.forEach(
          workloads,
          (workload) => preparer.prepare(state.runtime, workload),
          { concurrency: 4 },
        );
        const byCapability = new Map<CapabilityName, ReadonlyArray<PreparedWorkloadArtifact>>();
        for (const artifact of artifacts) {
          const existing = byCapability.get(artifact.capability) ?? [];
          byCapability.set(artifact.capability, [...existing, artifact]);
        }
        return {
          capabilities: plan.startOrder
            .filter((name) => selected.has(name))
            .map((name): PreparedCapability => {
              const outcome: PreparedCapability["outcome"] =
                state.runtime.kind === "native"
                  ? byCapability.get(name)?.some((entry) => entry.outcome === "downloaded")
                    ? "downloaded"
                    : "cached"
                  : byCapability.get(name)?.some((entry) => entry.outcome === "pulled")
                    ? "pulled"
                    : "cached";
              return { capability: name, version: definition.capabilities[name].version, outcome };
            }),
        };
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
          query?.cursor === undefined || query.cursor.opaque === "v1_0"
            ? undefined
            : { cursor: query.cursor },
        ).pipe(
          Effect.map((scanned) => {
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
            return {
              entries,
              cursor: scanned.at(-1)?.cursor ?? query?.cursor ?? { opaque: "v1_0" },
              running: false,
            } satisfies StackLogBatch;
          }),
        ),
      ),
      Effect.mapError((error) =>
        error instanceof StackOwnershipConflictError
          ? error
          : new StackStateInvalidError({ message: error.message, cause: error }),
      ),
    );
  const waitForRelease = () =>
    Effect.gen(function* () {
      if (
        (yield* readOwnerMetadata(
          options.environment.stateRoot,
          options.id,
          options.environment,
        )) !== undefined
      )
        return yield* new StackOwnershipConflictError({
          message: "Supervisor is still shutting down",
        });
      if (yield* ownerLockExists(options.environment.stateRoot, options.id))
        return yield* new StackOwnershipConflictError({
          message: "Supervisor ownership lease is still held",
        });
    }).pipe(
      Effect.retry(Schedule.spaced("25 millis").pipe(Schedule.upTo({ times: 200 }))),
      Effect.mapError((error) => new StackOwnershipConflictError({ message: error.message })),
      Effect.provideService(FileSystem.FileSystem, options.fileSystem),
      Effect.provideService(Path.Path, options.path),
      Effect.provideService(Crypto.Crypto, options.crypto),
    );
  return {
    resolveOwner,
    readOfflineState,
    readPersistedState,
    readLogs,
    waitForRelease,
    prepare,
  };
};

export const createStack = (
  options: CreateStackOptions,
): Effect.Effect<
  EffectStack,
  CreateStackError,
  Scope.Scope | FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawnerService
> =>
  Effect.gen(function* () {
    const env = yield* environment();
    const identity = yield* resolveStackIdentity({
      projectRoot: options.projectRoot,
      name: options.name,
    });
    const stackId = yield* deriveStackId(identity);
    const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
    const requestedRuntime: StackRuntime =
      options.runtime?.kind === "container"
        ? { kind: "container", engine: options.runtime.engine ?? "docker" }
        : { kind: "native" };
    const current = yield* store.initialize(
      stackId,
      stateInitial(identity, stackId, requestedRuntime),
    );
    const runtimeMismatch =
      options.runtime !== undefined &&
      (current.runtime.kind !== options.runtime.kind ||
        (options.runtime.kind === "container" &&
          current.runtime.kind === "container" &&
          options.runtime.engine !== undefined &&
          current.runtime.engine !== options.runtime.engine));
    if (runtimeMismatch)
      return yield* new StackRuntimeMismatchError({
        message: "Stack runtime is immutable for an existing identity",
      });
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
      id: stackId,
      identity,
      fileSystem: fs,
      path,
      crypto,
      spawner,
      containerEngineResolver,
    });
    return yield* makeHandle(stackId, {}, dependencies);
  });

export const openStack = (
  id: StackId,
): Effect.Effect<
  EffectStack,
  OpenStackError,
  Scope.Scope | FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawnerService
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
    const identity = runtimeIdentity(state.identity);
    const dependencies = handleDependencies({
      environment: env,
      store,
      id,
      identity,
      fileSystem: fs,
      path,
      crypto,
      spawner,
      containerEngineResolver,
    });
    return yield* makeHandle(id, {}, dependencies);
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
    return state === undefined ? Option.none() : Option.some(descriptor(state));
  });

export const listStacks = (
  options: ListStacksOptions = {},
): Effect.Effect<
  ReadonlyArray<StackDescriptor>,
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
      return [];
    const entries = yield* fs
      .readDirectory(env.stateRoot)
      .pipe(Effect.mapError((error) => new StackStateInvalidError({ message: error.message })));
    const result: StackDescriptor[] = [];
    for (const entry of entries) {
      if (!Schema.is(StackIdSchema)(entry)) continue;
      const state = yield* store.read(entry);
      if (
        state !== undefined &&
        (projectRoot === undefined || state.identity.projectRoot === projectRoot)
      )
        result.push(descriptor(state));
    }
    return result;
  });

export const inspectStack = (
  id: StackId,
): Effect.Effect<
  StackInspection,
  StackNotFoundError | StackDiscoveryError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const env = yield* environment();
    const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
    const state = yield* store.read(id);
    if (state === undefined)
      return yield* new StackNotFoundError({ stackId: id, message: "Stack state was not found" });
    const metadata = yield* readOwnerMetadata(env.stateRoot, id, env);
    if (metadata === undefined)
      return {
        descriptor: descriptor(state),
        owner: (yield* ownerLockExists(env.stateRoot, id)) ? "unreachable" : "absent",
      };
    if (metadata.rpcRelease !== STACK_RPC_RELEASE)
      return { descriptor: descriptor(state), owner: "incompatible" };
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
      if (
        Option.isSome(failure) &&
        (isMaintenanceTransportFailure(failure.value) ||
          (Predicate.isTagged(failure.value, "RpcClientError") &&
            Predicate.hasProperty(failure.value, "reason") &&
            (Predicate.isTagged(failure.value.reason, "SocketOpenError") ||
              Predicate.isTagged(failure.value.reason, "SocketReadError") ||
              Predicate.isTagged(failure.value.reason, "SocketWriteError") ||
              Predicate.isTagged(failure.value.reason, "SocketCloseError"))))
      )
        return { descriptor: descriptor(state), owner: "unreachable" };
      return { descriptor: descriptor(state), owner: "running" };
    }
    return { descriptor: descriptor(state), owner: "running", status: status.value };
  });
