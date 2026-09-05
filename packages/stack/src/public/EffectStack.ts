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
import { dependencyClosure, type ExecutionPlan } from "../model/ExecutionPlan.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { toPersistedIdentity } from "../state/StackState.ts";
import {
  isMissingStateRemnantError,
  makeStackStateStore,
  type StackStateStore,
} from "../state/StackStateStore.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { StackIdSchema, type StackId } from "./StackId.ts";
import type { StackRuntime, StackRuntimePreference } from "./Runtime.ts";
import type { StackConfig } from "./Config.ts";
import {
  type ArtifactPreparationStatus,
  type StackStatus,
  type StackDescriptor,
  type StackInspection,
} from "./Status.ts";
import { CAPABILITY_NAMES, type CapabilityName } from "./Capability.ts";
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
  PortAllocationError,
  PortUnavailableError,
  GatewayActivationError,
  InvalidLogCursorError,
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
  isStackError,
  isStackErrorTag,
  PREPARE_STACK_ERROR_TAGS,
  STACK_STATUS_ERROR_TAGS,
  STACK_CREDENTIALS_ERROR_TAGS,
  STACK_START_ERROR_TAGS,
  STACK_STOP_ERROR_TAGS,
  STACK_LOGS_ERROR_TAGS,
  DESTROY_STACK_ERROR_TAGS,
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
import { statusFor } from "../supervisor/StatusProjection.ts";
import { EMPTY_LOG_CURSOR, readRetainedLogs, selectLogBatch } from "../supervisor/LogStore.ts";
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
  /** Synchronous progress observer for this caller-owned preparation. */
  readonly onProgress?: (status: ArtifactPreparationStatus) => void;
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

const isCapabilityName = (value: unknown): value is CapabilityName =>
  typeof value === "string" && CAPABILITY_NAMES.some((name) => name === value);

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
} satisfies Record<StackErrorTag, (message: string) => StackError>;

const isOwnerUnreachable = (error: unknown): boolean =>
  Predicate.isTagged(error, "RpcClientError") ||
  Predicate.isTagged(error, "SocketError") ||
  isMaintenanceTransportFailure(error);

const errorForRpc = (error: ControlError): StackError => {
  if (isStackError(error)) return error;
  if (isOwnerUnreachable(error))
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

/** Internal control-transport seam used by public lifecycle integration tests. */
export interface HandleDependencies {
  readonly resolveOwner: (
    launch: boolean,
  ) => Effect.Effect<Option.Option<OwnerResolution>, StackError>;
  readonly readOfflineState: Effect.Effect<Option.Option<PersistedStackState>, StackError>;
  readonly readPersistedState: Effect.Effect<Option.Option<PersistedStackState>, StackError>;
  readonly readLogs: (query?: LogQuery) => Effect.Effect<StackLogBatch, StackLogsError>;
  readonly waitForRelease: Effect.Effect<void, StackStopError>;
  readonly prepare: (
    options?: PrepareStackOptions,
  ) => Effect.Effect<PrepareStackResult, PrepareStackError>;
}

/** @internal Owner metadata together with whether this handle launched the owner. */
export interface OwnerResolution {
  readonly owner: OwnerMetadata;
  readonly launched: boolean;
}

export const makeHandle = (id: StackId, options: HandleDependencies): Effect.Effect<EffectStack> =>
  Effect.sync(() => {
    const isStoppedState = (state: PersistedStackState): boolean =>
      state.desiredLifecycle === "stopped" || state.desiredLifecycle === "unconfigured";
    const stackNotFound = () => new StackNotFoundError({ message: "Stack state was not found" });
    type ResolvedClient = {
      readonly client: ReturnType<typeof makeControlClient>;
      readonly resolution: OwnerResolution;
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
                  resolution: resolution.value,
                  client: makeControlClient(resolution.value.owner.endpoint, {
                    stackId: id,
                    ownerSessionId: resolution.value.owner.ownerSessionId,
                    rpcRelease:
                      protocol === "rpc" ? STACK_RPC_RELEASE : resolution.value.owner.rpcRelease,
                  }),
                })
            : Effect.fail(
                new StackOwnershipConflictError({ message: "No Supervisor owns this stack" }),
              ),
        ),
      );
    const stopExactOwner = (owner: OwnerMetadata): Effect.Effect<void, StackCleanupError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = makeControlClient(owner.endpoint, {
            stackId: id,
            ownerSessionId: owner.ownerSessionId,
            rpcRelease: owner.rpcRelease,
          });
          const stop = yield* Effect.exit(client.stop());
          if (
            Exit.isSuccess(stop) &&
            !stop.value.ok &&
            stop.value.error.tag === "operation-failed" &&
            stop.value.error.stackErrorTag === "StackLifecycleConflictError"
          ) {
            return;
          }
          const release = yield* Effect.exit(options.waitForRelease);
          let cause: Cause.Cause<StackCleanupError> = Cause.empty;
          if (Exit.isFailure(stop)) {
            cause = Cause.combine(
              cause,
              Cause.fail(
                new StackCleanupError({
                  message: "Unable to stop freshly launched Supervisor",
                  cause: stop.cause,
                }),
              ),
            );
          } else if (!stop.value.ok) {
            cause = Cause.combine(
              cause,
              Cause.fail(
                new StackCleanupError({
                  message: stop.value.error.message,
                  cause: stop.value.error,
                }),
              ),
            );
          }
          if (Exit.isFailure(release)) {
            cause = Cause.combine(
              cause,
              Cause.fail(
                new StackCleanupError({
                  message: "Freshly launched Supervisor did not release ownership",
                  cause: release.cause,
                }),
              ),
            );
          }
          if (cause.reasons.length > 0) return yield* Effect.failCause(cause);
        }),
      );
    const shouldCleanupFreshOwner = (result: Exit.Exit<unknown, unknown>): boolean => {
      if (Exit.isSuccess(result)) return false;
      if (Cause.hasInterruptsOnly(result.cause)) return true;
      const failure = Cause.findErrorOption(result.cause);
      return Option.isSome(failure) && Predicate.isTagged(failure.value, "RpcClientError");
    };
    const cleanupLaunchedOwner = (
      resolution: OwnerResolution,
      result: Exit.Exit<unknown, unknown>,
    ): Effect.Effect<void, StackCleanupError> =>
      resolution.launched && shouldCleanupFreshOwner(result)
        ? Effect.uninterruptible(
            stopExactOwner(resolution.owner).pipe(
              Effect.catchCause((cleanupCause) =>
                Effect.fail(
                  new StackCleanupError({
                    message: "Unable to clean up freshly launched Supervisor",
                    cause: Cause.combine(
                      Exit.isFailure(result) ? result.cause : Cause.empty,
                      cleanupCause,
                    ),
                  }),
                ),
              ),
            ),
          )
        : Effect.void;
    const invoke = <A, E extends StackError>(
      call: (rpc: StackRpcClient) => Effect.Effect<A, StackRpcError | RpcClientError>,
      mapError: (error: ControlError) => E,
      launch = false,
    ): Effect.Effect<A, E> => {
      const rpcCall: Effect.Effect<A, StackRpcError | RpcClientError | StackError> = resolveClient(
        launch,
      ).pipe(
        Effect.flatMap(({ client, resolution }) =>
          Effect.scoped(client.rpc.pipe(Effect.flatMap(call))).pipe(
            Effect.onExit((result) =>
              launch ? cleanupLaunchedOwner(resolution, result) : Effect.void,
            ),
          ),
        ),
      );
      const mapped: Effect.Effect<A, E> = rpcCall.pipe(Effect.mapError(mapError));
      return mapped;
    };
    const destroyAndAwaitOwner: Effect.Effect<void, DestroyStackError> = resolveClient(true).pipe(
      Effect.mapError(destroyError),
      Effect.flatMap(({ client, resolution }) =>
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
          const destroyAttempt = ownerReady.pipe(
            Effect.andThen(
              Effect.scoped(client.rpc.pipe(Effect.flatMap((rpc) => rpc.destroy(undefined)))),
            ),
            Effect.onExit((attempt) => cleanupLaunchedOwner(resolution, attempt)),
            Effect.mapError(destroyError),
          );
          const result = yield* Effect.exit(
            destroyAttempt.pipe(
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
    const destroy = (): Effect.Effect<void, DestroyStackError> =>
      options.readPersistedState.pipe(
        Effect.mapError(destroyError),
        Effect.flatMap((state) =>
          Option.isNone(state) ? Effect.fail(stackNotFound()) : destroyAndAwaitOwner,
        ),
      );
    const status = () => {
      const rpcStatus = invoke((rpc) => rpc.status(undefined), statusError);
      return rpcStatus.pipe(
        Effect.catchTag("StackOwnershipConflictError", (ownershipError) =>
          options.readOfflineState.pipe(
            Effect.mapError(statusError),
            Effect.flatMap((state) =>
              Option.isNone(state)
                ? Effect.fail(stackNotFound())
                : isStoppedState(state.value)
                  ? statusFor(state.value, [], new Set<CapabilityName>(), "stopped").pipe(
                      Effect.mapError(statusError),
                    )
                  : Effect.fail(
                      new StackOwnershipConflictError({ message: "No Supervisor owns this stack" }),
                    ),
            ),
            Effect.catchTag("StackOwnershipConflictError", () => Effect.fail(ownershipError)),
          ),
        ),
      );
    };
    const credentials = (): Effect.Effect<EffectStackCredentials, StackCredentialsError> =>
      invoke((rpc) => rpc.credentials(undefined), credentialsError).pipe(
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
      );
    const start = (startOptions?: StartStackOptions) => {
      return invoke(
        (rpc) =>
          startOptions?.config === undefined
            ? rpc.start({})
            : rpc.start({ config: startOptions.config }),
        startError,
        true,
      ).pipe(
        Effect.tapError(() =>
          options.readPersistedState.pipe(
            Effect.flatMap((state) =>
              Option.isSome(state) && isStoppedState(state.value)
                ? options.waitForRelease.pipe(Effect.ignore)
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
          if (
            response.value.error.tag === "operation-failed" &&
            response.value.error.stackErrorTag !== undefined &&
            isStackErrorTag(response.value.error.stackErrorTag)
          ) {
            return yield* stackErrorFactories[response.value.error.stackErrorTag](
              response.value.error.message,
            );
          }
          return yield* new StackLifecycleConflictError({ message: response.value.error.message });
        }
        yield* Fiber.join(closeFiber).pipe(Effect.ignore);
        yield* options.waitForRelease;
      }).pipe(Effect.mapError(stopError));
    const launchAndStop = resolveClient(true, "maintenance").pipe(
      Effect.mapError(stopError),
      Effect.flatMap(({ client }) => stopOwner(client)),
    );
    const stop = () =>
      resolveClient(false, "maintenance").pipe(
        Effect.mapError(stopError),
        Effect.flatMap(({ client }) => stopOwner(client)),
        Effect.catchTag("StackOwnershipConflictError", () =>
          options.readOfflineState.pipe(
            Effect.mapError(stopError),
            Effect.flatMap((state) =>
              Option.isSome(state) && isStoppedState(state.value) ? Effect.void : launchAndStop,
            ),
            // Ownership artifacts that block the offline fast path may be
            // stale. Let ensureSupervisor arbitrate the lease; a live owner
            // remains protected and returns a typed conflict.
            Effect.catchTag("StackOwnershipConflictError", () => launchAndStop),
          ),
        ),
      );
    const prepare = (
      prepareOptions?: PrepareStackOptions,
    ): Effect.Effect<PrepareStackResult, PrepareStackError> => options.prepare(prepareOptions);
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
      status,
      credentials,
      prepare,
      start,
      stop,
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
        let definition: StackDefinition;
        let plan: ExecutionPlan;
        if (prepareOptions?.config === undefined && state.definition !== undefined) {
          definition = state.definition;
          plan = yield* rebuildExecutionPlan(state.runtime, definition);
        } else {
          const compiled = yield* compileStack(
            {
              projectRoot: state.identity.projectRoot,
              runtime: state.runtime,
              config: prepareOptions?.config,
            },
            state.definition === undefined ? undefined : { definition: state.definition },
          ).pipe(Effect.provideService(Path.Path, options.path));
          definition = compiled.definition;
          plan = compiled.executionPlan;
        }
        const selected = new Set<CapabilityName>();
        if (prepareOptions?.capabilities === undefined) {
          for (const name of CAPABILITY_NAMES)
            if (definition.capabilities[name].enabled) selected.add(name);
        } else {
          const requested: CapabilityName[] = [];
          for (const name of prepareOptions.capabilities) {
            if (!isCapabilityName(name))
              return yield* new StackPreparationError({
                stackId: options.id,
                capability: String(name),
                message: `Unknown capability ${String(name)}`,
              });
            requested.push(name);
          }
          for (const name of dependencyClosure(plan, requested)) {
            if (!definition.capabilities[name].enabled)
              return yield* new StackPreparationError({
                stackId: options.id,
                capability: name,
                message: `Capability ${name} is disabled`,
              });
            selected.add(name);
          }
        }
        const workloads = plan.workloads.filter((workload) => selected.has(workload.capability));
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
        );
        const artifacts = yield* Effect.forEach(
          workloads,
          (workload) => preparer.prepare(state.runtime, workload, prepareOptions?.onProgress),
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
  const waitForRelease = Effect.gen(function* () {
    if (
      (yield* readOwnerMetadata(options.environment.stateRoot, options.id, options.environment)) !==
      undefined
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
      (current.runtime.kind !== requestedRuntime.kind ||
        (requestedRuntime.kind === "container" &&
          current.runtime.kind === "container" &&
          current.runtime.engine !== requestedRuntime.engine));
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
      fileSystem: fs,
      path,
      crypto,
      spawner,
      containerEngineResolver,
    });
    return yield* makeHandle(stackId, dependencies);
  });

export const openStack = (
  id: StackId,
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
      const state = yield* store
        .read(entry)
        .pipe(Effect.catchIf(isMissingStateRemnantError, () => Effect.void));
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
      if (Option.isSome(failure) && isOwnerUnreachable(failure.value))
        return { descriptor: descriptor(state), owner: "unreachable" };
      return { descriptor: descriptor(state), owner: "running" };
    }
    return { descriptor: descriptor(state), owner: "running", status: status.value };
  });
