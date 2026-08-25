import { fork, type ChildProcess } from "node:child_process";
import {
  Cause,
  Context,
  Data,
  Duration,
  Effect,
  Fiber,
  Layer,
  Predicate,
  Schedule,
  Scope,
  Schema,
} from "effect";
import { HttpServer } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  selectStackRuntime,
  validateStackRuntime,
  type StackRuntimeSelection,
} from "./ContainerRuntime.ts";
import type { PlatformFactory } from "./createStack.ts";
import { DaemonServer } from "./DaemonServer.ts";
import { Stack } from "./Stack.ts";
import { foregroundLayer } from "./layers.ts";
import {
  acquireControl,
  ControlTransportError,
  type ControlAcquisition,
  type ControlAttached,
  type ControlEndpoint,
  type ControlOwnership,
  type ControlTransport,
} from "./managed/control.ts";
import {
  ManagedStackManager,
  type ManagedStackManagerConstructionError,
  type ManagedStackStartResult,
} from "./managed/manager.ts";
import {
  managedStackLaunchInputSchema,
  type ManagedStackLaunch,
  type ManagedStackLaunchInput,
} from "./managed/document.ts";
import { deriveStackId, ensureEnvironment } from "./managed/environment.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { validateManagedStackName, type ManagedPortIntentDocument } from "./managed/model.ts";
import { managedStackPathsEffect } from "./managed/paths.ts";
import { PORT_CATALOG, PORT_FIELDS } from "./PortCatalog.ts";
import { portFieldsForConfigInput } from "./ServicePorts.ts";
import { SERVICE_CATALOG, SERVICE_NAMES } from "./ServiceCatalog.ts";
import { dockerContainerName } from "./StackIdentity.ts";
import type { PortLease } from "./PortAllocator.ts";
import {
  portRequestsForConfig,
  resolveConfig,
  type DaemonConfigInput,
} from "./StackConfigResolver.ts";
import type { ResolvedDaemonConfig } from "./StackConfig.ts";
import { HttpTransportClient } from "./HttpTransportClient.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { terminateChildProcess } from "./terminateChild.ts";
import { dockerForceRemove } from "./cleanup.ts";

/** The only message sent across the detached child IPC boundary. */
export interface SupervisorStartMessage {
  readonly type: "start";
  readonly stackId: string;
  readonly workspacePath: string;
  readonly stackName: string;
  readonly stateRoot: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly portIntents: ManagedPortIntentDocument;
  readonly launch?: ManagedStackLaunchInput;
}

export interface SupervisorStartedMessage {
  readonly type: "started";
  readonly endpoint: ControlEndpoint;
  readonly attached?: boolean;
}

interface SupervisorErrorMessage {
  readonly type: "error";
  readonly message: string;
}

type SupervisorMessage = SupervisorStartedMessage | SupervisorErrorMessage;
/** Input shape for the public managed launcher. */
export interface ManagedDaemonStartInput {
  readonly workspacePath: string;
  readonly stackName: string;
  readonly stateRoot: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly portIntents: ManagedPortIntentDocument;
  readonly launch?: ManagedStackLaunchInput;
}

const supervisorPortIntentSchema = Schema.Struct({
  activeFields: Schema.Array(Schema.Literals(PORT_FIELDS)),
  disabledFields: Schema.optionalKey(Schema.Array(Schema.Literals(PORT_FIELDS))),
  document: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const supervisorStartMessageSchema = Schema.Struct({
  type: Schema.Literal("start"),
  stackId: Schema.String,
  workspacePath: Schema.String,
  stackName: Schema.String,
  stateRoot: Schema.String,
  config: Schema.Record(Schema.String, Schema.Unknown),
  portIntents: supervisorPortIntentSchema,
  launch: Schema.optionalKey(managedStackLaunchInputSchema),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isControlEndpoint = (value: unknown): value is ControlEndpoint =>
  isRecord(value) &&
  typeof value.hostname === "string" &&
  typeof value.port === "number" &&
  typeof value.url === "string";

const isControlOwnership = (value: ControlAcquisition): value is ControlOwnership =>
  Predicate.isTagged(value, "Owned");

const isControlAttached = (value: ControlAcquisition): value is ControlAttached =>
  Predicate.isTagged(value, "Attached");

const decodeSupervisorStartMessage = (
  value: unknown,
): Effect.Effect<SupervisorStartMessage, SupervisorStartError> =>
  Schema.decodeUnknownEffect(supervisorStartMessageSchema)(value).pipe(
    Effect.mapError((cause) => new SupervisorStartError({ message: causeMessage(cause) })),
  );

const causeMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "detail" in cause &&
    typeof cause.detail === "string"
  ) {
    return cause.detail;
  }
  return typeof cause === "string" ? cause : String(cause);
};

const runtimeSelectionForLaunch = (launch: ManagedStackLaunch): StackRuntimeSelection =>
  launch.mode === "native"
    ? { mode: "native", containerRuntime: null }
    : { mode: "docker", containerRuntime: launch.containerRuntime };

const toDaemonConfig = (value: Readonly<Record<string, unknown>>): DaemonConfigInput | undefined =>
  typeof value.cwd === "string" ? { ...value, cwd: value.cwd } : undefined;

/**
 * The CLI's omitted-mode defaults are empty service objects, optionally
 * decorated with only a pinned version. A managed caller's non-default field
 * is an explicit request and must survive fallback so native validation can
 * reject it instead of silently changing the requested stack.
 */
const isCatalogDefaultServiceConfig = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.keys(value).every((key) => key === "version");
};

const nativeFallbackConfig = (config: DaemonConfigInput): DaemonConfigInput => {
  const servicePolicies: NonNullable<DaemonConfigInput["servicePolicies"]> = {
    ...config.servicePolicies,
  };

  for (const service of SERVICE_NAMES) {
    const metadata = SERVICE_CATALOG[service];
    if (
      metadata.runtimeSupport === "docker-only" &&
      servicePolicies[service] === undefined &&
      isCatalogDefaultServiceConfig(config[metadata.configKey])
    ) {
      servicePolicies[service] = "off";
    }
  }

  return { ...config, servicePolicies };
};

export class SupervisorStartError extends Data.TaggedError("SupervisorStartError")<{
  readonly message: string;
  readonly reason?: "owner-stopped";
}> {}

class SupervisorOwnerUnavailableError extends Data.TaggedError("SupervisorOwnerUnavailableError")<{
  readonly retry: boolean;
  readonly detail: string;
}> {}

class SupervisorOwnerReacquirePending extends Data.TaggedError(
  "SupervisorOwnerReacquirePending",
)<{}> {}

const OWNER_STOPPED_AFTER_TAKEOVER = "Attached supervisor owner stopped before takeover";
const STACK_STOPPED_DURING_STARTUP = "Stack was stopped during startup";

const SUPERVISOR_STARTUP_TIMEOUT = "30 seconds" as const;
const SUPERVISOR_HANDSHAKE_TIMEOUT = "35 seconds" as const;

const awaitOwnerReady = (
  acquisition: ControlAttached,
  onWaiting: Effect.Effect<void, SupervisorStartError> = Effect.void,
): Effect.Effect<
  import("./managed/control.ts").ControlOwnerStatus,
  | SupervisorStartError
  | import("./managed/control.ts").ControlTransportError
  | import("./managed/control.ts").ControlProtocolError
  | import("./managed/control.ts").ControlProtocolMismatchError
  | import("./managed/control.ts").ControlAddressConflictError
> =>
  acquisition.ownerStatus.pipe(
    Effect.flatMap((status) => {
      if (status.state === "running" && status.ready) return Effect.succeed(status);
      return Effect.fail(
        new SupervisorOwnerUnavailableError({
          retry: status.state === "starting" || status.state === "stopping",
          detail: `Attached supervisor owner is ${status.state} before becoming ready`,
        }),
      );
    }),
    Effect.retry({
      schedule: Schedule.spaced("25 millis").pipe(
        Schedule.tap(({ attempt }) => (attempt === 1 ? onWaiting : Effect.void)),
      ),
      while: (error) => Predicate.isTagged(error, "SupervisorOwnerUnavailableError") && error.retry,
    }),
    Effect.catchTag("SupervisorOwnerUnavailableError", (error) =>
      Effect.fail(new SupervisorStartError({ message: error.detail })),
    ),
  );

export interface SupervisorPlatform {
  readonly platformFactory: PlatformFactory;
  /** Optional platform-owned runtime layer, primarily for non-Docker environments. */
  readonly runtimeLayer?: (input: {
    readonly config: ResolvedDaemonConfig;
    readonly lease: PortLease;
  }) => Effect.Effect<Layer.Layer<Stack>, unknown, Scope.Scope>;
  /** Optional notification hook for an attached owner that is not ready yet. */
  readonly onAttachedBeforeReady?: () => Effect.Effect<void, SupervisorStartError>;
  readonly resolutionTimeout?: Duration.Input;
  readonly managerLayer: (
    stateRoot: string,
  ) => Layer.Layer<
    ManagedStackManager,
    ManagedStackManagerConstructionError,
    ControlTransport | import("effect").FileSystem.FileSystem | import("effect").Path.Path
  >;
}

const receiveStartMessage = (): Effect.Effect<SupervisorStartMessage, SupervisorStartError> =>
  Effect.callback((resume) => {
    const onMessage = (value: unknown) => {
      cleanup();
      resume(decodeSupervisorStartMessage(value));
    };
    const onDisconnect = () => {
      cleanup();
      resume(
        new SupervisorStartError({ message: "Supervisor parent disconnected before startup" }),
      );
    };
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    process.once("message", onMessage);
    process.once("disconnect", onDisconnect);
    return Effect.sync(cleanup);
  });

const sendMessage = (message: SupervisorMessage): Effect.Effect<void, SupervisorStartError> =>
  Effect.callback((resume) => {
    if (process.send === undefined || !process.connected) {
      resume(Effect.void);
      return Effect.void;
    }
    try {
      process.send(message, (error) =>
        resume(
          error === null
            ? Effect.void
            : Effect.fail(new SupervisorStartError({ message: error.message })),
        ),
      );
    } catch (cause) {
      resume(Effect.fail(new SupervisorStartError({ message: causeMessage(cause) })));
    }
    return Effect.void;
  });

const waitForSignal = (): Effect.Effect<"SIGINT" | "SIGTERM"> =>
  Effect.callback((resume) => {
    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    const onSigint = () => {
      cleanup();
      resume(Effect.succeed("SIGINT"));
    };
    const onSigterm = () => {
      cleanup();
      resume(Effect.succeed("SIGTERM"));
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    return Effect.sync(cleanup);
  });

const startDaemon = (input: {
  readonly config: ResolvedDaemonConfig;
  readonly lease: PortLease;
  readonly ownership: ControlOwnership;
  readonly platform: SupervisorPlatform;
  readonly scope: Scope.Scope;
  readonly launchUpdate?: (
    launch: import("./managed/document.ts").ManagedStackLaunchUpdate,
  ) => Effect.Effect<void, unknown>;
}): Effect.Effect<
  { readonly daemon: DaemonServer["Service"] },
  unknown,
  import("effect").FileSystem.FileSystem | import("effect").Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const appLayer =
      input.platform.runtimeLayer === undefined
        ? foregroundLayer(input.config, input.platform.platformFactory, input.lease)
        : yield* input.platform.runtimeLayer({ config: input.config, lease: input.lease });
    const appServices = yield* Layer.buildWithScope(appLayer, input.scope);
    const localStack = Context.get(appServices, Stack);
    const daemonLayer = DaemonServer.layerWithShutdown(
      Effect.gen(function* () {
        yield* input.ownership.setState("stopping", false);
        yield* localStack.stop();
      }),
      input.ownership.ownerStatus,
      {
        includeOwnerRoute: false,
        stopOnShutdown: false,
        ...(input.launchUpdate === undefined ? {} : { launchUpdate: input.launchUpdate }),
      },
    ).pipe(
      Layer.provide(Layer.succeed(Stack, localStack)),
      Layer.provide(Layer.succeed(HttpServer.HttpServer, input.ownership.server)),
    );
    const daemonServices = yield* Layer.buildWithScope(daemonLayer, input.scope);
    const daemon = Context.get(daemonServices, DaemonServer);
    return { daemon };
  });

const runManaged = (
  input: SupervisorStartMessage,
  platform: SupervisorPlatform,
  scope: Scope.Scope,
): Effect.Effect<
  void,
  unknown,
  | ControlTransport
  | import("effect").FileSystem.FileSystem
  | import("effect").Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
> => {
  let owner: ControlOwnership | undefined;
  let managerService: ManagedStackManager["Service"] | undefined;
  let claimedStack = false;
  return Effect.gen(function* () {
    yield* validateManagedStackName(input.stackName);
    const configInput = toDaemonConfig(input.config);
    if (configInput === undefined) {
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Supervisor config is missing cwd" }),
      );
    }
    const initialAcquisition = yield* acquireControl({ stackId: input.stackId });
    if (isControlOwnership(initialAcquisition)) owner = initialAcquisition;
    const manager = yield* ManagedStackManager.pipe(
      Effect.provide(platform.managerLayer(input.stateRoot)),
    );
    managerService = manager;
    const discovered = manager
      .ensureWorkspace(input.workspacePath)
      .pipe(Effect.map((discovery) => ({ _tag: "discovered" as const, discovery })));
    const discoveryResult = yield* isControlOwnership(initialAcquisition)
      ? Effect.raceFirst(
          discovered,
          initialAcquisition.stopRequested.pipe(Effect.as({ _tag: "stopped" as const })),
        )
      : discovered;
    if (Predicate.isTagged(discoveryResult, "stopped")) {
      yield* sendMessage({ type: "error", message: STACK_STOPPED_DURING_STARTUP });
      return;
    }
    const stackId = deriveStackId(discoveryResult.discovery.identity, input.stackName);
    if (stackId !== input.stackId) {
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Workspace identity changed before supervisor start" }),
      );
    }
    const requestedMode = configInput.mode ?? input.launch?.mode;
    const existing = yield* manager.inspectStack(stackId);
    const persistedRuntime: StackRuntimeSelection | undefined =
      existing === undefined ? undefined : runtimeSelectionForLaunch(existing.launch);
    if (
      isControlAttached(initialAcquisition) &&
      persistedRuntime !== undefined &&
      requestedMode !== undefined &&
      persistedRuntime.mode !== requestedMode
    ) {
      return yield* Effect.fail(
        new SupervisorStartError({
          message: `Stack runtime is already ${persistedRuntime.mode}; requested ${requestedMode}. Delete and recreate the stack (removing its managed data) before changing execution mode.`,
        }),
      );
    }
    let attachedOwnerWasStopping = false;
    const reacquireAfterDeath = (): Effect.Effect<ControlAcquisition, unknown, Scope.Scope> =>
      manager.acquireControl(stackId).pipe(
        Effect.flatMap((candidate): Effect.Effect<ControlAcquisition, unknown, Scope.Scope> => {
          if (isControlOwnership(candidate)) return Effect.succeed(candidate);
          return candidate.ownerStatus.pipe(
            Effect.flatMap((status): Effect.Effect<never, unknown> =>
              status.state === "starting"
                ? Effect.fail(new SupervisorOwnerReacquirePending())
                : Effect.fail(
                    new SupervisorStartError({
                      message: `Attached supervisor owner is ${status.state} after disconnect`,
                    }),
                  ),
            ),
            Effect.catch((error) =>
              error instanceof ControlTransportError
                ? Effect.fail(new SupervisorOwnerReacquirePending())
                : Effect.fail(error),
            ),
          );
        }),
        Effect.retry({
          schedule: Schedule.spaced("25 millis"),
          while: (error) => error instanceof SupervisorOwnerReacquirePending,
        }),
      );
    const attachedResolution = isControlAttached(initialAcquisition)
      ? initialAcquisition.ownerStatus.pipe(
          Effect.tap((status) =>
            Effect.sync(() => {
              attachedOwnerWasStopping = status.state === "stopping";
            }),
          ),
          Effect.flatMap((status) =>
            status.state === "running" && status.ready
              ? Effect.succeed(status)
              : awaitOwnerReady(
                  initialAcquisition,
                  platform.onAttachedBeforeReady?.() ?? Effect.void,
                ),
          ),
          Effect.as(initialAcquisition),
          Effect.catch((error) =>
            error instanceof ControlTransportError ? reacquireAfterDeath() : Effect.fail(error),
          ),
        )
      : Effect.succeed(initialAcquisition);
    const acquisition = yield* attachedResolution.pipe(
      Effect.timeout(platform.resolutionTimeout ?? SUPERVISOR_STARTUP_TIMEOUT),
      Effect.catch((error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        Predicate.isTagged(error, "TimeoutError")
          ? Effect.fail(
              new SupervisorStartError({
                message: "Timed out resolving attached supervisor owner",
              }),
            )
          : Effect.fail(error),
      ),
    );
    if (isControlAttached(initialAcquisition)) {
      const revalidated = yield* manager.ensureWorkspace(input.workspacePath);
      const revalidatedStackId = deriveStackId(revalidated.identity, input.stackName);
      if (revalidatedStackId !== stackId) {
        return yield* Effect.fail(
          new SupervisorStartError({
            message: "Workspace identity changed before supervisor attach",
          }),
        );
      }
    }
    if (isControlAttached(acquisition)) {
      // The first inspection can legitimately race the owner's initial
      // document write. Once the owner reports ready, its persisted launch is
      // the authoritative runtime contract for an explicit request.
      const attachedExisting = yield* manager.inspectStack(stackId);
      const attachedPersistedRuntime =
        attachedExisting === undefined
          ? undefined
          : runtimeSelectionForLaunch(attachedExisting.launch);
      if (
        requestedMode !== undefined &&
        (attachedPersistedRuntime === undefined || attachedPersistedRuntime.mode !== requestedMode)
      ) {
        const observedMode = attachedPersistedRuntime?.mode ?? "unknown";
        return yield* Effect.fail(
          new SupervisorStartError({
            message: `Stack runtime is already ${observedMode}; requested ${requestedMode}. Delete and recreate the stack (removing its managed data) before changing execution mode.`,
          }),
        );
      }
      yield* sendMessage({ type: "started", endpoint: acquisition.endpoint, attached: true });
      process.disconnect?.();
      return;
    }
    const ownership = acquisition;
    owner = ownership;
    const ownedExisting = yield* manager.inspectStack(stackId);
    if (isControlAttached(initialAcquisition) && !attachedOwnerWasStopping) {
      if (ownedExisting?.lifecycle === "stopped") {
        yield* ownership.close;
        return yield* Effect.fail(
          new SupervisorStartError({
            message: OWNER_STOPPED_AFTER_TAKEOVER,
            reason: "owner-stopped",
          }),
        );
      }
    }
    const ownedPersistedRuntime =
      ownedExisting === undefined ? undefined : runtimeSelectionForLaunch(ownedExisting.launch);
    if (
      ownedPersistedRuntime !== undefined &&
      requestedMode !== undefined &&
      ownedPersistedRuntime.mode !== requestedMode
    ) {
      return yield* Effect.fail(
        new SupervisorStartError({
          message: `Stack runtime is already ${ownedPersistedRuntime.mode}; requested ${requestedMode}. Delete and recreate the stack (removing its managed data) before changing execution mode.`,
        }),
      );
    }
    const runtime =
      ownedPersistedRuntime === undefined
        ? yield* selectStackRuntime(requestedMode)
        : yield* validateStackRuntime(ownedPersistedRuntime);
    const runtimeConfigInput =
      runtime.mode === "native" && requestedMode === undefined
        ? nativeFallbackConfig(configInput)
        : configInput;
    const activeFields = portFieldsForConfigInput({ ...runtimeConfigInput, mode: runtime.mode });
    const activeFieldSet = new Set(activeFields);
    const portIntents: ManagedPortIntentDocument = {
      ...input.portIntents,
      activeFields,
      disabledFields: PORT_FIELDS.filter(
        (field) => PORT_CATALOG[field].persistence === "sticky" && !activeFieldSet.has(field),
      ),
    };
    // Validate policies and explicit ports before manager.startStack writes
    // `starting` or acquires the managed lease.
    yield* portRequestsForConfig(runtimeConfigInput, { runtime });
    const launchInput = input.launch ?? { versions: {} };
    const launch: ManagedStackLaunch =
      runtime.mode === "native"
        ? { ...launchInput, mode: "native" }
        : { ...launchInput, mode: "docker", containerRuntime: runtime.containerRuntime };
    const startup = Effect.gen(function* () {
      if (
        ownedExisting !== undefined &&
        (ownedExisting.lifecycle === "starting" ||
          ownedExisting.lifecycle === "running" ||
          ownedExisting.lifecycle === "failed" ||
          ownedExisting.lifecycle === "deleting")
      ) {
        if (runtime.mode === "docker") {
          yield* dockerForceRemove(
            runtime.containerRuntime,
            SERVICE_NAMES.map((service) => dockerContainerName(service, `id-${stackId}`)),
          );
        }
      }
      const started: ManagedStackStartResult = yield* manager.startStack({
        workspacePath: input.workspacePath,
        stackName: input.stackName,
        portDocument: portIntents,
        ownership,
        lifecycle: "starting",
        launch,
      });
      claimedStack = true;
      const managedPaths = yield* managedStackPathsEffect(input.stateRoot, started.stack.id);
      const resolved = yield* resolveConfig(
        {
          ...runtimeConfigInput,
          projectDir: runtimeConfigInput.projectDir ?? input.workspacePath,
          stackRoot: managedPaths.root,
          runtimeRoot: managedPaths.runtime,
          instanceId: started.stack.id,
        },
        { runtime, ports: started.lease.ports },
      );
      const config: ResolvedDaemonConfig = {
        ...resolved,
        name: input.stackName,
        projectDir: runtimeConfigInput.projectDir ?? input.workspacePath,
      };
      yield* manager.recordLifecycle(ownership, {
        stackId: started.stack.id,
        lifecycle: "starting",
      });
      const built = yield* startDaemon({
        config,
        lease: started.lease,
        ownership,
        platform,
        scope,
        launchUpdate: (launch) =>
          manager
            .updateLaunch(ownership, { stackId: started.stack.id, launch })
            .pipe(Effect.asVoid),
      });
      yield* manager.recordLifecycle(ownership, {
        stackId: started.stack.id,
        lifecycle: "running",
        runtime: {
          pid: process.pid,
          controlEndpoint: ownership.endpoint.url,
          protocolVersion: 1,
        },
      });
      yield* sendMessage({
        type: "started",
        endpoint: ownership.endpoint,
        attached: false,
      });
      process.disconnect?.();
      return { started, built };
    });
    const startupResult = yield* Effect.raceFirst(
      startup.pipe(Effect.map((result) => ({ _tag: "started" as const, ...result }))),
      ownership.stopRequested.pipe(Effect.as({ _tag: "stopped" as const })),
    );
    if (Predicate.isTagged(startupResult, "stopped")) {
      const current = yield* manager.inspectStack(stackId);
      if (current !== undefined) {
        yield* manager.recordLifecycle(ownership, { stackId, lifecycle: "stopped" });
      }
      yield* sendMessage({ type: "error", message: STACK_STOPPED_DURING_STARTUP });
      return;
    }
    const { started, built } = startupResult;
    const shutdown = yield* Effect.raceFirst(
      Effect.raceFirst(waitForSignal(), built.daemon.awaitShutdown).pipe(
        Effect.as("shutdown" as const),
      ),
      ownership.stopRequested.pipe(Effect.as("requested" as const)),
    );
    if (shutdown === "requested") yield* built.daemon.beginShutdown;
    yield* manager.recordLifecycle(ownership, { stackId: started.stack.id, lifecycle: "stopped" });
  }).pipe(
    Effect.catchCause((cause) => {
      const failure = Cause.squash(cause);
      if (failure instanceof SupervisorStartError && failure.reason === "owner-stopped") {
        return Effect.failCause(cause);
      }
      if (!claimedStack || owner === undefined || managerService === undefined) {
        return Effect.failCause(cause);
      }
      return managerService
        .recordLifecycle(owner, {
          stackId: owner.ownershipId,
          lifecycle: "failed",
        })
        .pipe(
          Effect.matchCauseEffect({
            onFailure: () => Effect.failCause(cause),
            onSuccess: () => Effect.failCause(cause),
          }),
        );
    }),
  );
};

/** Effect-native child program. Node/Bun entrypoints only call runPromise here. */
export const runSupervisor = (
  platform: SupervisorPlatform,
): Effect.Effect<
  void,
  unknown, // SupervisorStartError plus arbitrary child-program failures
  | ControlTransport
  | import("effect").FileSystem.FileSystem
  | import("effect").Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const input = yield* receiveStartMessage();
      yield* Effect.matchCauseEffect(runManaged(input, platform, scope), {
        onFailure: (cause) =>
          sendMessage({ type: "error", message: causeMessage(Cause.squash(cause)) }).pipe(
            Effect.andThen(Effect.failCause(cause)),
          ),
        onSuccess: Effect.succeed,
      });
    }),
  );

const forkSupervisor = (entryPoint: string): Effect.Effect<ChildProcess, SupervisorStartError> =>
  Effect.try({
    try: () =>
      fork(entryPoint, [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: true,
        env: { ...process.env, SUPABASE_STACK_RUN_DAEMON: "1" },
      }),
    catch: (cause) =>
      new SupervisorStartError({ message: `Failed to fork supervisor: ${causeMessage(cause)}` }),
  });

const sendStart = (
  child: ChildProcess,
  message: SupervisorStartMessage,
): Effect.Effect<void, SupervisorStartError> =>
  Effect.callback((resume) => {
    try {
      child.send(message, (error) =>
        resume(
          error === null
            ? Effect.void
            : Effect.fail(new SupervisorStartError({ message: error.message })),
        ),
      );
    } catch (cause) {
      resume(Effect.fail(new SupervisorStartError({ message: causeMessage(cause) })));
    }
    return Effect.void;
  });

const waitForStarted = (
  child: ChildProcess,
): Effect.Effect<SupervisorStartedMessage, SupervisorStartError> =>
  Effect.callback((resume) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (value: unknown) => {
      cleanup();
      if (isRecord(value) && value.type === "started" && isControlEndpoint(value.endpoint)) {
        resume(
          Effect.succeed({
            type: "started",
            endpoint: value.endpoint,
            ...(value.attached === true ? { attached: true } : {}),
          }),
        );
      } else if (isRecord(value) && value.type === "error" && typeof value.message === "string") {
        resume(Effect.fail(new SupervisorStartError({ message: value.message })));
      } else {
        resume(Effect.fail(new SupervisorStartError({ message: "Invalid supervisor response" })));
      }
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(Effect.fail(new SupervisorStartError({ message: cause.message })));
    };
    const onExit = (code: number | null) => {
      cleanup();
      resume(
        Effect.fail(new SupervisorStartError({ message: `Supervisor exited with code ${code}` })),
      );
    };
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
    return Effect.sync(cleanup);
  });

/** Parent-side launcher for the managed supervisor. */
export const supervisorLayer = (
  input: SupervisorStartMessage,
  entryPoint: string,
): Effect.Effect<
  Layer.Layer<import("./Stack.ts").Stack>,
  SupervisorStartError | import("./managed/model.ts").InvalidManagedStackNameError,
  HttpTransportClient
> =>
  Effect.gen(function* () {
    yield* validateManagedStackName(input.stackName);
    const client = yield* HttpTransportClient;
    const child = yield* forkSupervisor(entryPoint);
    let detached = false;
    return yield* Effect.gen(function* () {
      const responseFiber = yield* waitForStarted(child).pipe(
        Effect.timeout(SUPERVISOR_HANDSHAKE_TIMEOUT),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new SupervisorStartError({ message: "Timed out waiting for supervisor startup" }),
          ),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* sendStart(child, input);
      const response = yield* Fiber.join(responseFiber);
      child.unref();
      detached = true;
      return RemoteStack.layer(response.endpoint).pipe(
        Layer.provide(Layer.succeed(HttpTransportClient, client)),
      );
    }).pipe(
      Effect.onExit(() =>
        detached ? Effect.void : terminateChildProcess(child).pipe(Effect.ignore),
      ),
    );
  });

export const managedDaemonLayer = (
  input: ManagedDaemonStartInput,
  entryPoint: string,
): Effect.Effect<
  Layer.Layer<Stack>,
  SupervisorStartError | import("./managed/model.ts").InvalidManagedStackNameError,
  HttpTransportClient | import("effect").FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    yield* validateManagedStackName(input.stackName);
    const discovery = yield* ensureEnvironment(input.workspacePath).pipe(
      Effect.provide(gitConfigStoreLayer),
      Effect.mapError((error) => new SupervisorStartError({ message: error.message })),
    );
    return yield* supervisorLayer(
      {
        type: "start",
        stackId: deriveStackId(discovery.identity, input.stackName),
        workspacePath: input.workspacePath,
        stackName: input.stackName,
        stateRoot: input.stateRoot,
        config: {
          ...input.config,
          cwd: typeof input.config.cwd === "string" ? input.config.cwd : input.workspacePath,
        },
        portIntents: input.portIntents,
        ...(input.launch === undefined ? {} : { launch: input.launch }),
      },
      entryPoint,
    );
  });
