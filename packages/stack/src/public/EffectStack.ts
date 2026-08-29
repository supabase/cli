import { Crypto, Effect, Exit, FileSystem, Option, Path, Ref, Scope, Schema, Stream } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { SocketError } from "effect/unstable/socket/Socket";
import type { StackIdentity } from "../identity/Identity.ts";
import { resolveStackIdentity, deriveStackId } from "../identity/Identity.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { toPersistedIdentity } from "../state/StackState.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { StackIdSchema, type StackId } from "./StackId.ts";
import type { StackRuntime, StackRuntimePreference } from "./Runtime.ts";
import type { StackConfig } from "./Config.ts";
import type { StackStatus, StackDescriptor, StackInspection } from "./Status.ts";
import type { CapabilityName } from "./Capability.ts";
import type { LogOptions, StackLogEntry } from "./Logs.ts";
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
  StackUpgradeReplacementError,
  StackStateGenerationMismatchError,
  StackStateInvalidError,
  StackStateFormatUnsupportedError,
  StackUpgradeRequiredError,
  StackMustBeStoppedError,
  PortAllocationError,
  PortUnavailableError,
  GatewayAuthenticationError,
  GatewayStaleGenerationError,
  GatewayActivationError,
  type CreateStackError,
  type OpenStackError,
  type StackDiscoveryError,
  type StackStatusError,
  type StackCredentialsError,
  type PrepareStackError,
  type StackStartError,
  type StackRestartError,
  type StackStopError,
  type StackCloseError,
  type StackStatusWatchError,
  type StackLogsError,
  type DestroyStackError,
  type StackError,
} from "./Errors.ts";
import { readOwnerMetadata } from "../state/Ownership.ts";
import { makeControlClient } from "../control/ControlServer.ts";
import { MaintenanceProtocolError } from "../control/MaintenanceProtocol.ts";
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
  selectContainerEngine,
  type ContainerEngineKind,
  type ContainerPlatform,
} from "../runtime/ContainerEngine.ts";
import { makeDockerEngine } from "../runtime/DockerEngine.ts";
import { makePodmanEngine } from "../runtime/PodmanEngine.ts";

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
  readonly restart: (options?: StartStackOptions) => Effect.Effect<StackStatus, StackRestartError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly stop: () => Effect.Effect<void, StackStopError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly destroy: () => Effect.Effect<void, DestroyStackError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly close: () => Effect.Effect<void, StackCloseError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly watchStatus: () => Stream.Stream<StackStatus, StackStatusWatchError>;
  // oxlint-disable-next-line effecttsgo/lazy-effect
  readonly logs: (options?: LogOptions) => Stream.Stream<StackLogEntry, StackLogsError>;
}

const runtimeFor = (
  preference: StackRuntimePreference | undefined,
  engine?: ContainerEngineKind,
): StackRuntime =>
  preference?.kind === "container"
    ? {
        kind: "container",
        engine: engine ?? (preference.engine === "podman" ? "podman" : "docker"),
      }
    : { kind: "native" };

const defaultContainerPlatform = (): ContainerPlatform => {
  // Host details are read only at this composition boundary. The real
  // container adapters reject unsupported Podman routing during preflight.
  if (process.platform === "darwin") return { os: "darwin", desktop: true };
  if (process.platform === "win32") return { os: "windows", desktop: true };
  return { os: "linux", desktop: false };
};

const defaultContainerEngineResolver = (): ContainerEngineResolverShape => ({
  resolve: (preference) =>
    Effect.gen(function* () {
      const platform = defaultContainerPlatform();
      const dockerRunner = yield* makeProcessCommandRunner({ executable: "docker" });
      const podmanRunner = yield* makeProcessCommandRunner({ executable: "podman" });
      const docker = makeDockerEngine({ runner: dockerRunner, platform });
      const podman = makePodmanEngine({ runner: podmanRunner, platform });
      const selected = yield* selectContainerEngine({ preference, docker, podman });
      yield* selected.preflight;
      return selected.kind;
    }),
});

const resolveRuntime = (
  preference: StackRuntimePreference | undefined,
): Effect.Effect<
  StackRuntime,
  ContainerEngineError,
  import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner
> =>
  preference?.kind !== "container"
    ? Effect.succeed({ kind: "native" })
    : Effect.serviceOption(ContainerEngineResolver).pipe(
        Effect.map((service) =>
          Option.isSome(service) ? service.value : defaultContainerEngineResolver(),
        ),
        Effect.flatMap((resolver) => resolver.resolve(preference.engine ?? "auto")),
        Effect.map((engine) => runtimeFor(preference, engine)),
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

type ControlError = StackRpcError | RpcClientError | SocketError | MaintenanceProtocolError;

const errorForRpc = (error: ControlError): StackError => {
  if (
    typeof error === "object" &&
    error !== null &&
    "tag" in error &&
    "message" in error &&
    typeof error.tag === "string" &&
    typeof error.message === "string"
  ) {
    switch (error.tag) {
      case "InvalidStackIdentityError":
        return new InvalidStackIdentityError({ message: error.message });
      case "InvalidProjectRootError":
        return new InvalidProjectRootError({ message: error.message });
      case "InvalidStackConfigError":
        return new InvalidStackConfigError({ message: error.message });
      case "StackVersionUnsupportedError":
        return new StackVersionUnsupportedError({ message: error.message });
      case "StackNotFoundError":
        return new StackNotFoundError({ message: error.message });
      case "StackDefinitionRequiredError":
        return new StackDefinitionRequiredError({ message: error.message });
      case "StackNotRunningError":
        return new StackNotRunningError({ message: error.message });
      case "StackUpgradeRequiredError":
        return new StackUpgradeRequiredError({ message: error.message });
      case "StackUpgradeReplacementError":
        return new StackUpgradeReplacementError({ message: error.message });
      case "StackDestructionError":
        return new StackDestructionError({ message: error.message });
      case "StackOwnershipConflictError":
        return new StackOwnershipConflictError({ message: error.message });
      case "StackRuntimeMismatchError":
        return new StackRuntimeMismatchError({ message: error.message });
      case "StackMustBeStoppedError":
        return new StackMustBeStoppedError({ message: error.message });
      case "StackLifecycleConflictError":
        return new StackLifecycleConflictError({ message: error.message });
      case "StackStateInvalidError":
        return new StackStateInvalidError({ message: error.message });
      case "StackStateFormatUnsupportedError":
        return new StackStateFormatUnsupportedError({ message: error.message });
      case "StackStateGenerationMismatchError":
        return new StackStateGenerationMismatchError({ message: error.message });
      case "StackSecretMismatchError":
        return new StackSecretMismatchError({ message: error.message });
      case "InvalidJwtSigningMaterialError":
        return new InvalidJwtSigningMaterialError({ message: error.message });
      case "PortAllocationError":
        return new PortAllocationError({ message: error.message });
      case "PortUnavailableError":
        return new PortUnavailableError({ message: error.message });
      case "GatewayAuthenticationError":
        return new GatewayAuthenticationError({ message: error.message });
      case "GatewayStaleGenerationError":
        return new GatewayStaleGenerationError({ message: error.message });
      case "GatewayActivationError":
        return new GatewayActivationError({ message: error.message });
      case "StackPreparationError":
        return new StackPreparationError({ message: error.message });
      case "ArtifactIntegrityError":
        return new ArtifactIntegrityError({ message: error.message });
      case "ContainerPullError":
        return new ContainerPullError({ message: error.message });
      case "StackReconciliationError":
        return new StackReconciliationError({ message: error.message });
      case "ServiceStartError":
        return new ServiceStartError({ message: error.message });
      case "ServiceReadinessError":
        return new ServiceReadinessError({ message: error.message });
      case "ContainerEngineError":
        return new ContainerEngineError({ message: error.message });
      case "StackRpcProtocolError":
        return new StackStateInvalidError({ message: error.message });
      default:
        return new StackStateInvalidError({ message: error.message });
    }
  }
  return new StackStateInvalidError({ message: "Stack control request failed" });
};

const statusError = (error: ControlError): StackStatusError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackNotFoundError ||
    mapped instanceof StackStateInvalidError ||
    mapped instanceof StackStateFormatUnsupportedError ||
    mapped instanceof StackUpgradeRequiredError
    ? mapped
    : new StackStateInvalidError({ message: "Stack control request failed" });
};

const credentialsError = (error: ControlError): StackCredentialsError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackNotFoundError ||
    mapped instanceof StackNotRunningError ||
    mapped instanceof StackSecretMismatchError ||
    mapped instanceof InvalidJwtSigningMaterialError
    ? mapped
    : new StackNotRunningError({ message: "Stack credentials are unavailable" });
};

const prepareError = (error: ControlError): PrepareStackError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackPreparationError ||
    mapped instanceof ArtifactIntegrityError ||
    mapped instanceof ContainerPullError
    ? mapped
    : new StackPreparationError({ message: "Stack preparation failed" });
};

const startError = (error: ControlError): StackStartError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackDefinitionRequiredError ||
    mapped instanceof StackVersionUnsupportedError ||
    mapped instanceof StackLifecycleConflictError ||
    mapped instanceof StackStateInvalidError ||
    mapped instanceof StackStateFormatUnsupportedError ||
    mapped instanceof StackUpgradeRequiredError ||
    mapped instanceof StackSecretMismatchError ||
    mapped instanceof StackReconciliationError ||
    mapped instanceof ServiceStartError ||
    mapped instanceof ServiceReadinessError ||
    mapped instanceof ContainerEngineError
    ? mapped
    : new StackStateInvalidError({ message: "Stack start failed" });
};

const restartError = (error: ControlError): StackRestartError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackUpgradeReplacementError ? mapped : startError(error);
};

const stopError = (error: ControlError): StackStopError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackNotRunningError ||
    mapped instanceof StackLifecycleConflictError ||
    mapped instanceof StackReconciliationError ||
    mapped instanceof ServiceReadinessError ||
    mapped instanceof ContainerEngineError
    ? mapped
    : new StackLifecycleConflictError({ message: "Stack stop failed" });
};

const destroyError = (error: ControlError): DestroyStackError => {
  const mapped = errorForRpc(error);
  return mapped instanceof StackDestructionError ||
    mapped instanceof StackNotFoundError ||
    mapped instanceof StackLifecycleConflictError ||
    mapped instanceof ContainerEngineError
    ? mapped
    : new StackDestructionError({ message: "Stack destruction failed" });
};

const makeHandle = (
  id: StackId,
  metadata: {
    readonly endpoint: Parameters<typeof makeControlClient>[0];
    readonly ownerSessionId: string;
    readonly rpcRelease: string;
  },
): Effect.Effect<EffectStack> =>
  Effect.gen(function* () {
    const closed = yield* Ref.make(false);
    const client = makeControlClient(metadata.endpoint, {
      stackId: id,
      ownerSessionId: metadata.ownerSessionId,
      rpcRelease: metadata.rpcRelease,
    });
    const check = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Ref.get(closed).pipe(Effect.flatMap((isClosed) => (isClosed ? Effect.interrupt : effect)));
    const invoke = <A, E extends StackError>(
      call: (rpc: StackRpcClient) => Effect.Effect<A, StackRpcError | RpcClientError>,
      mapError: (error: ControlError) => E,
    ) => check(Effect.scoped(client.rpc.pipe(Effect.flatMap(call), Effect.mapError(mapError))));
    const status = () => invoke((rpc) => rpc.status(undefined), statusError);
    return {
      id,
      status,
      credentials: () => invoke((rpc) => rpc.credentials(undefined), credentialsError),
      prepare: (options) =>
        invoke(
          (rpc) => rpc.prepare({ config: options?.config, capabilities: options?.capabilities }),
          prepareError,
        ),
      start: (options) => invoke((rpc) => rpc.start({ config: options?.config }), startError),
      restart: (options) => invoke((rpc) => rpc.restart({ config: options?.config }), restartError),
      stop: () =>
        check(
          Effect.scoped(client.stop()).pipe(
            Effect.mapError((error) => stopError(error)),
            Effect.flatMap((response) =>
              response.ok
                ? Effect.void
                : Effect.fail(new StackLifecycleConflictError({ message: response.error.message })),
            ),
          ),
        ),
      destroy: () => invoke((rpc) => rpc.destroy(undefined), destroyError),
      close: () => Ref.set(closed, true),
      watchStatus: () =>
        Stream.unwrap(
          check(
            client.rpc.pipe(
              Effect.map((rpc) => rpc.watchStatus(undefined).pipe(Stream.mapError(statusError))),
              Effect.mapError(statusError),
            ),
          ),
        ).pipe(Stream.scoped),
      logs: (options) =>
        Stream.unwrap(
          check(
            client.rpc.pipe(
              Effect.map((rpc) =>
                rpc.logs(options ?? {}).pipe(
                  Stream.mapError((error) => {
                    const mapped = errorForRpc(error);
                    return mapped instanceof StackNotFoundError ||
                      mapped instanceof StackNotRunningError ||
                      mapped instanceof StackStateInvalidError
                      ? mapped
                      : new StackStateInvalidError({ message: "Stack logs are unavailable" });
                  }),
                ),
              ),
              Effect.mapError((error) => {
                const mapped = errorForRpc(error);
                return mapped instanceof StackNotFoundError ||
                  mapped instanceof StackNotRunningError ||
                  mapped instanceof StackStateInvalidError
                  ? mapped
                  : new StackStateInvalidError({ message: "Stack logs are unavailable" });
              }),
            ),
          ),
        ).pipe(Stream.scoped),
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
  desiredGeneration: 0,
  portsGeneration: null,
  desiredLifecycle: "unconfigured",
  ports: [],
  privatePorts: [],
  secrets: {},
});

export const createStack = (
  options: CreateStackOptions,
): Effect.Effect<
  EffectStack,
  CreateStackError,
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const env = yield* environment();
    const identity = yield* resolveStackIdentity({
      projectRoot: options.projectRoot,
      name: options.name,
    });
    const stackId = yield* deriveStackId(identity);
    const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
    const current =
      options.runtime?.kind === "container"
        ? yield* Effect.gen(function* () {
            const existing = yield* store.read(stackId);
            const runtime =
              existing === undefined ? yield* resolveRuntime(options.runtime) : existing.runtime;
            return (
              existing ??
              (yield* store.initialize(stackId, stateInitial(identity, stackId, runtime)))
            );
          })
        : yield* store.initialize(stackId, stateInitial(identity, stackId, { kind: "native" }));
    const runtimeMismatch =
      options.runtime !== undefined &&
      (current.runtime.kind !== options.runtime.kind ||
        (options.runtime.kind === "container" &&
          current.runtime.kind === "container" &&
          options.runtime.engine !== undefined &&
          options.runtime.engine !== "auto" &&
          current.runtime.engine !== options.runtime.engine));
    if (runtimeMismatch)
      return yield* new StackRuntimeMismatchError({
        message: "Stack runtime is immutable for an existing identity",
      });
    const owner = yield* ensureSupervisor({
      identity,
      stackId,
      stateStore: store,
      environment: env,
    });
    return yield* makeHandle(stackId, owner);
  });

export const openStack = (
  id: StackId,
): Effect.Effect<
  EffectStack,
  OpenStackError,
  Scope.Scope | FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const env = yield* environment();
    const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
    const state = yield* store.read(id);
    if (state === undefined)
      return yield* new StackNotFoundError({ stackId: id, message: "Stack state was not found" });
    const owner = yield* readOwnerMetadata(env.stateRoot, id, env);
    if (owner === undefined)
      return yield* new StackOwnershipConflictError({
        stackId: id,
        message: "No Supervisor owns this stack",
      });
    if (owner.rpcRelease !== STACK_RPC_RELEASE)
      return yield* new StackUpgradeRequiredError({
        message: `Stack owner release ${owner.rpcRelease} requires explicit restart`,
        expectedRelease: STACK_RPC_RELEASE,
        actualRelease: owner.rpcRelease,
      });
    const probe = yield* makeControlClient(owner.endpoint, {
      stackId: id,
      ownerSessionId: owner.ownerSessionId,
    })
      .probe()
      .pipe(
        Effect.mapError(
          (error) => new StackOwnershipConflictError({ stackId: id, message: String(error) }),
        ),
      );
    if (
      !probe.ok ||
      probe.op !== "probe" ||
      probe.stackId !== id ||
      probe.ownerSessionId !== owner.ownerSessionId
    )
      return yield* new StackOwnershipConflictError({
        stackId: id,
        message: "Owner session probe failed",
      });
    return yield* makeHandle(id, owner);
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
    if (metadata === undefined) return { descriptor: descriptor(state), owner: "absent" };
    if (metadata.rpcRelease !== STACK_RPC_RELEASE)
      return { descriptor: descriptor(state), owner: "incompatible" };
    const probe = yield* Effect.scoped(
      makeControlClient(metadata.endpoint, {
        stackId: id,
        ownerSessionId: metadata.ownerSessionId,
      }).probe(),
    ).pipe(Effect.exit);
    if (Exit.isFailure(probe)) return { descriptor: descriptor(state), owner: "unreachable" };
    if (
      !probe.value.ok ||
      probe.value.op !== "probe" ||
      probe.value.stackId !== id ||
      probe.value.ownerSessionId !== metadata.ownerSessionId
    )
      return { descriptor: descriptor(state), owner: "incompatible" };
    return { descriptor: descriptor(state), owner: "running" };
  });
