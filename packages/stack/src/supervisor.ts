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
  Queue,
  Schedule,
  Scope,
  Schema,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  selectStackRuntime,
  validateStackRuntime,
  type StackRuntimeSelection,
} from "./ContainerRuntime.ts";
import type { PlatformFactory } from "./createStack.ts";
import { Stack } from "./Stack.ts";
import { LocalStackLifecycle } from "./LocalStack.ts";
import { makeSupervisorControlApplication } from "./SupervisorControlServer.ts";
import type { StackLaunchUpdater } from "./StackRpcHandlers.ts";
import type { StackLaunchUpdateRpc } from "./StackRpc.ts";
import { SupervisorSession } from "./SupervisorSession.ts";
import {
  SupervisorErrorEventSchema,
  SupervisorStartCommandSchema,
  SupervisorStartedEventSchema,
} from "./SupervisorProtocol.ts";
import { foregroundLayer } from "./layers.ts";
import {
  acquireControl,
  ControlTransportError,
  ControlTransport,
  type ControlAcquisition,
  type ControlAttached,
  type ControlOwnership,
  type ControlApplication,
  type ControlAddressConflictError,
  type ControlBindError,
  type ControlProtocolError,
  type ControlProtocolMismatchError,
  type InvalidControlOwnershipIdError,
} from "./managed/control.ts";
import {
  ManagedStackManager,
  type ManagedStackManagerConstructionError,
  type ManagedStackStartResult,
} from "./managed/manager.ts";
import {
  managedStackLaunchUpdateSchema,
  type ManagedStackLaunch,
  type ManagedStackLaunchInput,
} from "./managed/document.ts";
import { deriveStackId, ensureEnvironment } from "./managed/environment.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { validateManagedStackName, type ManagedPortIntentDocument } from "./managed/model.ts";
import { managedStackPathsEffect } from "./managed/paths.ts";
import { PORT_CATALOG, PORT_FIELDS } from "./PortCatalog.ts";
import { portFieldsForConfigInput } from "./ServicePorts.ts";
import { SERVICE_NAMES } from "./ServiceCatalog.ts";
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
import {
  CONTROL_PROTOCOL_VERSION,
  isControlSupervisorStatus,
  type ControlSupervisorStatus,
} from "./DaemonProtocol.ts";
import {
  DaemonUpgradeRequired,
  StackBuildError,
  StackRpcProtocolError,
  StackRpcTransportError,
  SupervisorStartError,
} from "./errors.ts";
import { runtimeSelectionForLaunch, applyNativeDefaults } from "./SupervisorUpgradeRestart.ts";
import type {
  SupervisorErrorMessage,
  SupervisorStartMessage,
  SupervisorStartedMessage,
} from "./SupervisorProtocol.ts";
export type { SupervisorStartMessage, SupervisorStartedMessage };
export { SupervisorStartError } from "./errors.ts";
type SupervisorMessage = SupervisorStartedMessage | SupervisorErrorMessage;
/** Input shape for the public managed launcher. */
export interface ManagedDaemonStartInput {
  readonly cliVersion: string;
  readonly workspacePath: string;
  readonly stackName: string;
  readonly stateRoot: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly portIntents: ManagedPortIntentDocument;
  readonly launch?: ManagedStackLaunchInput;
}

const supervisorStartMessageSchema = SupervisorStartCommandSchema;

const isControlOwnership = (value: ControlAcquisition): value is ControlOwnership =>
  Predicate.isTagged(value, "Owned");

const isControlAttached = (value: ControlAcquisition): value is ControlAttached =>
  Predicate.isTagged(value, "Attached");

const startedOwnerDescriptor = (
  status: ControlSupervisorStatus,
): SupervisorStartedMessage["owner"] => ({
  kind: "supervisor",
  ownershipId: status.ownershipId,
  ownerSessionId: status.ownerSessionId,
  controlProtocolVersion: status.controlProtocolVersion,
  daemonCliVersion: status.daemonCliVersion,
  state: status.state,
  ready: status.ready,
});

const decodeSupervisorStartMessage = (
  value: unknown,
): Effect.Effect<SupervisorStartMessage, SupervisorStartError> =>
  Schema.decodeUnknownEffect(supervisorStartMessageSchema)(value).pipe(
    Effect.mapError((cause) => new SupervisorStartError({ message: causeMessage(cause) })),
  );

const causeMessage = (cause: unknown): string => {
  if (cause instanceof ControlTransportError) {
    return `ControlTransportError(${cause.reason}): ${cause.cause instanceof Error ? cause.cause.message : String(cause.cause)}`;
  }
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

const toDaemonConfig = (value: Readonly<Record<string, unknown>>): DaemonConfigInput | undefined =>
  typeof value.cwd === "string" ? { ...value, cwd: value.cwd } : undefined;

class SupervisorOwnerUnavailableError extends Data.TaggedError("SupervisorOwnerUnavailableError")<{
  readonly retry: boolean;
  readonly detail: string;
}> {}

class SupervisorOwnerReacquirePending extends Data.TaggedError(
  "SupervisorOwnerReacquirePending",
)<{}> {}

const OWNER_STOPPED_AFTER_TAKEOVER = "Attached supervisor owner stopped before takeover";
const STACK_STOPPED_DURING_STARTUP = "Stack was stopped during startup";

const SUPERVISOR_STARTUP_TIMEOUT = Duration.seconds(30);
const SUPERVISOR_HANDSHAKE_GRACE = Duration.seconds(5);
const SUPERVISOR_HANDSHAKE_TIMEOUT = Duration.sum(
  SUPERVISOR_STARTUP_TIMEOUT,
  SUPERVISOR_HANDSHAKE_GRACE,
);

const awaitOwnerReady = (
  acquisition: ControlAttached,
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
      if (!isControlSupervisorStatus(status)) {
        return Effect.fail(
          new SupervisorOwnerUnavailableError({
            retry: false,
            detail: `Managed stack is busy with ${status.operation} maintenance`,
          }),
        );
      }
      if (status.state === "running" && status.ready) return Effect.succeed(status);
      return Effect.fail(
        new SupervisorOwnerUnavailableError({
          retry: status.state === "starting" || status.state === "stopping",
          detail: `Attached supervisor owner is ${status.state} before becoming ready`,
        }),
      );
    }),
    Effect.retry({
      schedule: Schedule.spaced("25 millis"),
      while: (error) =>
        (Predicate.isTagged(error, "SupervisorOwnerUnavailableError") && error.retry) ||
        (Predicate.isTagged(error, "ControlTransportError") && error.reason === "transport"),
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
  }) => Effect.Effect<Layer.Layer<Stack | LocalStackLifecycle>, unknown, Scope.Scope>;
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
  Effect.gen(function* () {
    const schema =
      message.type === "error" ? SupervisorErrorEventSchema : SupervisorStartedEventSchema;
    const encoded = yield* Schema.encodeEffect(schema)(message).pipe(
      Effect.mapError((cause) => new SupervisorStartError({ message: causeMessage(cause) })),
    );
    yield* Effect.callback<void, SupervisorStartError>((resume) => {
      if (process.send === undefined || !process.connected) {
        resume(Effect.void);
        return Effect.void;
      }
      try {
        process.send(encoded, (error) =>
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
  });

const decodeSupervisorEvent = (
  value: unknown,
): Effect.Effect<SupervisorStartedMessage, SupervisorStartError | DaemonUpgradeRequired> =>
  decodeSupervisorStartedOrError(value);

const decodeSupervisorStartedOrError = (
  value: unknown,
): Effect.Effect<SupervisorStartedMessage, SupervisorStartError | DaemonUpgradeRequired> =>
  Schema.decodeUnknownEffect(SupervisorStartedEventSchema)(value).pipe(
    Effect.map((event): SupervisorStartedMessage => ({
      type: "started",
      endpoint: event.endpoint,
      owner: event.owner,
      ...(event.attached === undefined ? {} : { attached: event.attached }),
    })),
    Effect.mapError((cause) => new SupervisorStartError({ message: causeMessage(cause) })),
    Effect.catch(() =>
      Schema.decodeUnknownEffect(SupervisorErrorEventSchema)(value).pipe(
        Effect.flatMap(
          (event): Effect.Effect<never, DaemonUpgradeRequired | SupervisorStartError> => {
            if (
              event.errorCode === "DAEMON_UPGRADE_REQUIRED" &&
              event.stackId !== undefined &&
              event.oldCliVersion !== undefined &&
              event.newCliVersion !== undefined &&
              event.state !== undefined &&
              event.ready !== undefined
            ) {
              return Effect.fail(
                new DaemonUpgradeRequired({
                  stackId: event.stackId,
                  oldCliVersion: event.oldCliVersion,
                  newCliVersion: event.newCliVersion,
                  state: event.state,
                  ready: event.ready,
                }),
              );
            }
            return Effect.fail(new SupervisorStartError({ message: event.message }));
          },
        ),
        Effect.mapError((cause) =>
          cause instanceof DaemonUpgradeRequired || cause instanceof SupervisorStartError
            ? cause
            : new SupervisorStartError({ message: causeMessage(cause) }),
        ),
      ),
    ),
  );

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

const supervisorErrorMessage = (cause: Cause.Cause<unknown>): SupervisorErrorMessage => {
  const error = Cause.squash(cause);
  if (error instanceof DaemonUpgradeRequired) {
    return {
      type: "error",
      message: `Daemon CLI version mismatch for ${error.stackId}: expected ${error.newCliVersion}, observed ${error.oldCliVersion}`,
      errorCode: "DAEMON_UPGRADE_REQUIRED",
      stackId: error.stackId,
      oldCliVersion: error.oldCliVersion,
      newCliVersion: error.newCliVersion,
      state: error.state,
      ready: error.ready,
    };
  }
  return { type: "error", message: causeMessage(error) };
};

const startDaemon = (input: {
  readonly config: ResolvedDaemonConfig;
  readonly lease: PortLease;
  readonly platform: SupervisorPlatform;
  readonly scope: Scope.Scope;
}): Effect.Effect<
  {
    readonly stack: Stack["Service"];
    readonly localLifecycle: LocalStackLifecycle["Service"];
  },
  unknown,
  import("effect").FileSystem.FileSystem | import("effect").Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const appLayer =
      input.platform.runtimeLayer === undefined
        ? foregroundLayer(input.config, input.platform.platformFactory, input.lease)
        : yield* input.platform
            .runtimeLayer({ config: input.config, lease: input.lease })
            .pipe(Scope.provide(input.scope));
    const appServices = yield* Layer.buildWithScope(appLayer, input.scope);
    const localStack = Context.get(appServices, Stack);
    const localLifecycle = Context.get(appServices, LocalStackLifecycle);
    return { stack: localStack, localLifecycle };
  });

const makeRunManagedExecution = (
  input: SupervisorStartMessage,
  platform: SupervisorPlatform,
): Effect.Effect<
  void,
  unknown,
  | ControlTransport
  | import("effect").FileSystem.FileSystem
  | import("effect").Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const controlTransport = yield* ControlTransport;
    yield* validateManagedStackName(input.stackName);
    const configInput = toDaemonConfig(input.config);
    if (configInput === undefined) {
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Supervisor config is missing cwd" }),
      );
    }
    const manager = yield* ManagedStackManager.pipe(
      Effect.provide(platform.managerLayer(input.stateRoot)),
    );
    const sessionController = yield* SupervisorSession.make({
      ownershipId: input.stackId,
      ownerSessionId: crypto.randomUUID(),
      daemonCliVersion: input.cliVersion,
    });
    const session = sessionController.service;
    let owner: ControlOwnership | undefined;
    const launchUpdater: StackLaunchUpdater = {
      update: (stackId: string, launch: StackLaunchUpdateRpc) => {
        const currentOwner = owner;
        if (currentOwner === undefined) {
          return Effect.fail(
            new StackBuildError({ detail: "Managed launch updates require an owned supervisor" }),
          );
        }
        return Schema.decodeUnknownEffect(managedStackLaunchUpdateSchema)(launch).pipe(
          Effect.mapError((cause) => new StackBuildError({ detail: causeMessage(cause) })),
          Effect.flatMap((decoded) =>
            manager.updateLaunch(currentOwner, { stackId, launch: decoded }),
          ),
          Effect.mapError((cause) => new StackBuildError({ detail: causeMessage(cause) })),
          Effect.asVoid,
        );
      },
    };
    const controlApplication: ControlApplication = {
      app: yield* makeSupervisorControlApplication(session, launchUpdater),
    };
    let initialAcquisition = yield* acquireControl({
      stackId: input.stackId,
      initialStatus: yield* session.currentStatus,
      application: controlApplication,
    });
    const requestedMode = configInput.mode ?? input.launch?.mode;
    const initiallyAttached = isControlAttached(initialAcquisition);
    const awaitAttachedOwnerReady = (acquisition: ControlAttached) =>
      awaitOwnerReady(acquisition).pipe(
        Effect.timeout(platform.resolutionTimeout ?? SUPERVISOR_STARTUP_TIMEOUT),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new SupervisorStartError({
              message: "Timed out resolving attached supervisor owner",
            }),
          ),
        ),
      );
    const reacquireAfterDeath = (
      stackId: string,
    ): Effect.Effect<
      ControlAcquisition,
      | SupervisorOwnerReacquirePending
      | DaemonUpgradeRequired
      | ControlAddressConflictError
      | ControlBindError
      | ControlTransportError
      | ControlProtocolError
      | ControlProtocolMismatchError
      | InvalidControlOwnershipIdError
      | SupervisorStartError,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const status = yield* session.currentStatus;
        const candidate = yield* acquireControl({
          stackId,
          initialStatus: status,
          application: controlApplication,
        }).pipe(Effect.provideService(ControlTransport, controlTransport));
        if (isControlOwnership(candidate)) return candidate;
        if (!isControlSupervisorStatus(candidate.observedStatus)) {
          return yield* Effect.fail(
            new SupervisorStartError({
              message: `Managed stack is busy with ${candidate.observedStatus.operation} maintenance`,
            }),
          );
        }
        if (candidate.observedStatus.daemonCliVersion !== input.cliVersion) {
          return yield* Effect.fail(
            new DaemonUpgradeRequired({
              stackId,
              oldCliVersion: candidate.observedStatus.daemonCliVersion,
              newCliVersion: input.cliVersion,
              state: candidate.observedStatus.state,
              ready: candidate.observedStatus.ready,
            }),
          );
        }
        yield* awaitAttachedOwnerReady(candidate).pipe(
          Effect.mapError((error) =>
            Predicate.isTagged(error, "SupervisorStartError") ||
            (Predicate.isTagged(error, "ControlTransportError") && error.reason === "unreachable")
              ? new SupervisorOwnerReacquirePending()
              : error,
          ),
        );
        return candidate;
      }).pipe(
        Effect.retry({
          schedule: Schedule.spaced("25 millis"),
          while: (error) => error instanceof SupervisorOwnerReacquirePending,
        }),
      );
    if (isControlAttached(initialAcquisition)) {
      const attachedStatus = initialAcquisition.observedStatus;
      if (!isControlSupervisorStatus(attachedStatus)) {
        return yield* Effect.fail(
          new SupervisorStartError({
            message: `Managed stack is busy with ${attachedStatus.operation} maintenance`,
          }),
        );
      }
      const discovery = yield* manager.ensureWorkspace(input.workspacePath);
      const stackId = deriveStackId(discovery.identity, input.stackName);
      if (stackId !== input.stackId) {
        return yield* Effect.fail(
          new SupervisorStartError({
            message: "Workspace identity changed before supervisor attach",
          }),
        );
      }
      const existing = yield* manager.inspectStack(stackId);
      const persistedRuntime: StackRuntimeSelection | undefined =
        existing === undefined ? undefined : runtimeSelectionForLaunch(existing.launch);
      if (
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
      if (attachedStatus.daemonCliVersion !== input.cliVersion) {
        return yield* Effect.fail(
          new DaemonUpgradeRequired({
            stackId,
            oldCliVersion: attachedStatus.daemonCliVersion,
            newCliVersion: input.cliVersion,
            state: attachedStatus.state,
            ready: attachedStatus.ready,
          }),
        );
      } else {
        const reacquireInitialAcquisition = () =>
          reacquireAfterDeath(stackId).pipe(
            Effect.tap((next) =>
              Effect.sync(() => {
                initialAcquisition = next;
              }),
            ),
            Effect.asVoid,
          );
        yield* awaitAttachedOwnerReady(initialAcquisition).pipe(
          Effect.catchTags({
            ControlTransportError: (error) =>
              error.reason === "unreachable" ? reacquireInitialAcquisition() : Effect.fail(error),
            ControlAddressConflictError: reacquireInitialAcquisition,
            ControlProtocolError: reacquireInitialAcquisition,
            ControlProtocolMismatchError: reacquireInitialAcquisition,
          }),
        );
      }
    }
    const acquisition = initialAcquisition;
    if (isControlAttached(acquisition)) {
      const revalidated = yield* manager.ensureWorkspace(input.workspacePath);
      if (deriveStackId(revalidated.identity, input.stackName) !== input.stackId) {
        return yield* Effect.fail(
          new SupervisorStartError({
            message: "Workspace identity changed before supervisor attach",
          }),
        );
      }
      // The first inspection can legitimately race the owner's initial
      // document write. Once the owner reports ready, its persisted launch is
      // the authoritative runtime contract for an explicit request.
      const attachedExisting = yield* manager.inspectStack(input.stackId);
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
      const attachedStatus = yield* acquisition.ownerStatus;
      if (!isControlSupervisorStatus(attachedStatus)) {
        return yield* Effect.fail(
          new SupervisorStartError({
            message: `Managed stack is busy with ${attachedStatus.operation} maintenance`,
          }),
        );
      }
      yield* sendMessage({
        type: "started",
        endpoint: acquisition.endpoint,
        owner: startedOwnerDescriptor(attachedStatus),
        attached: true,
      });
      process.disconnect?.();
      return;
    }
    const ownership = acquisition;
    owner = ownership;
    let claimedStack = false;
    const startup = (runtimeScope: Scope.Scope) =>
      Effect.gen(function* () {
        const discovery = yield* manager.ensureWorkspace(input.workspacePath);
        const stackId = deriveStackId(discovery.identity, input.stackName);
        if (stackId !== input.stackId) {
          return yield* Effect.fail(
            new SupervisorStartError({
              message: "Workspace identity changed before supervisor start",
            }),
          );
        }
        const ownedExisting = yield* manager.inspectStack(stackId);
        if (
          (initiallyAttached || input.replacement === true) &&
          ownedExisting?.lifecycle === "stopped" &&
          ownedExisting.stopIntent === "explicit"
        ) {
          return yield* Effect.fail(
            new SupervisorStartError({
              message: OWNER_STOPPED_AFTER_TAKEOVER,
            }),
          );
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
            ? applyNativeDefaults(configInput)
            : configInput;
        const activeFields = portFieldsForConfigInput({
          ...runtimeConfigInput,
          mode: runtime.mode,
        });
        const activeFieldSet = new Set(activeFields);
        const portIntents: ManagedPortIntentDocument = {
          ...input.portIntents,
          activeFields,
          disabledFields: PORT_FIELDS.filter(
            (field) => PORT_CATALOG[field].persistence === "sticky" && !activeFieldSet.has(field),
          ),
        };
        yield* portRequestsForConfig(runtimeConfigInput, { runtime });
        const launchInput = input.launch ?? { versions: {} };
        const launch: ManagedStackLaunch =
          runtime.mode === "native"
            ? { ...launchInput, mode: "native" }
            : { ...launchInput, mode: "docker", containerRuntime: runtime.containerRuntime };
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
          preservePersistedPorts: input.replacement === true,
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
          platform,
          scope: runtimeScope,
        });
        return { started, built };
      });
    const result = yield* sessionController.run({
      startup,
      stack: (runtime) => runtime.built.stack,
      awaitDisposed: (runtime) => runtime.built.localLifecycle.awaitDisposed,
      onRunning: (runtime) =>
        manager
          .recordLifecycle(ownership, {
            stackId: runtime.started.stack.id,
            lifecycle: "running",
            runtime: {
              pid: process.pid,
              controlEndpoint: ownership.endpoint.url,
              protocolVersion: CONTROL_PROTOCOL_VERSION,
            },
          })
          .pipe(
            Effect.andThen(session.currentStatus),
            Effect.flatMap((status) =>
              sendMessage({
                type: "started",
                endpoint: ownership.endpoint,
                owner: startedOwnerDescriptor({ ...status, state: "running", ready: true }),
                attached: false,
              }),
            ),
            Effect.tap(() => Effect.sync(() => process.disconnect?.())),
          ),
      onStopped: (intent) =>
        Effect.gen(function* () {
          const current = yield* manager.inspectStack(input.stackId);
          if (current?.lifecycle !== "starting" && current?.lifecycle !== "running") return;
          yield* manager
            .recordLifecycle(ownership, {
              stackId: input.stackId,
              lifecycle: "stopped",
              ...(intent === "explicit" ? { stopIntent: "explicit" as const } : {}),
            })
            .pipe(Effect.asVoid);
        }),
      onFailure: () =>
        Effect.gen(function* () {
          const current = yield* manager.inspectStack(input.stackId);
          if (
            current === undefined ||
            current.lifecycle === "deleting" ||
            (!claimedStack &&
              current.lifecycle !== "starting" &&
              current.lifecycle !== "running" &&
              current.lifecycle !== "failed")
          ) {
            return;
          }
          yield* manager
            .recordLifecycle(ownership, {
              stackId: input.stackId,
              lifecycle: "failed",
            })
            .pipe(Effect.asVoid);
        }),
      closeOwner: ownership.close,
      errorDetail: (cause) => causeMessage(Cause.squash(cause)),
    });
    if (!result.started) {
      yield* sendMessage({ type: "error", message: STACK_STOPPED_DURING_STARTUP });
    }
  });

const runManaged = (
  input: SupervisorStartMessage,
  platform: SupervisorPlatform,
): ReturnType<typeof makeRunManagedExecution> =>
  Effect.suspend(() => makeRunManagedExecution(input, platform));

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
      const input = yield* receiveStartMessage();
      const execution = Effect.raceFirst(
        runManaged(input, platform),
        waitForSignal().pipe(Effect.andThen(Effect.interrupt)),
      );
      yield* Effect.matchCauseEffect(execution, {
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : sendMessage(supervisorErrorMessage(cause)).pipe(
                Effect.andThen(Effect.failCause(cause)),
              ),
        onSuccess: Effect.succeed,
      });
    }),
  );

const forkSupervisor = (entryPoint: string): Effect.Effect<ChildProcess, SupervisorStartError> =>
  Effect.try({
    try: () => {
      // A compiled Bun executable cannot execute the source daemon path from
      // Bun's virtual filesystem. Keep that path as the fork module so Bun
      // installs its IPC channel, but re-execute the current compiled binary
      // and let the entrypoint's daemon marker select runBunDaemon().
      const compiledBunEntryPoint = /[\\/]\$bunfs[\\/]/.test(entryPoint);
      return fork(entryPoint, [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: true,
        ...(compiledBunEntryPoint ? { execPath: process.execPath } : {}),
        env: { ...process.env, SUPABASE_STACK_RUN_DAEMON: "1" },
      });
    },
    catch: (cause) =>
      new SupervisorStartError({ message: `Failed to fork supervisor: ${causeMessage(cause)}` }),
  });

const sendStart = (
  child: ChildProcess,
  message: SupervisorStartMessage,
): Effect.Effect<void, SupervisorStartError> =>
  Effect.gen(function* () {
    const config = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
      message.config,
    ).pipe(Effect.mapError((cause) => new SupervisorStartError({ message: causeMessage(cause) })));
    const document =
      message.portIntents.document === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
            message.portIntents.document,
          ).pipe(
            Effect.mapError((cause) => new SupervisorStartError({ message: causeMessage(cause) })),
          );
    const encoded = yield* Schema.encodeEffect(SupervisorStartCommandSchema)({
      ...message,
      config,
      portIntents: {
        activeFields: message.portIntents.activeFields,
        ...(message.portIntents.disabledFields === undefined
          ? {}
          : { disabledFields: message.portIntents.disabledFields }),
        ...(document === undefined ? {} : { document }),
      },
    }).pipe(Effect.mapError((cause) => new SupervisorStartError({ message: causeMessage(cause) })));
    yield* Effect.callback<void, SupervisorStartError>((resume) => {
      try {
        child.send(encoded, (error) =>
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
  });

const waitForStarted = (
  child: ChildProcess,
): Effect.Effect<SupervisorStartedMessage, SupervisorStartError | DaemonUpgradeRequired> =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = Stream.callback<unknown, SupervisorStartError>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            let finished = false;
            const cleanup = () => {
              child.off("message", onMessage);
              child.off("error", onError);
              child.off("exit", onExit);
            };
            const fail = (error: SupervisorStartError) => {
              if (finished) return;
              finished = true;
              Queue.failCauseUnsafe(queue, Cause.fail(error));
              cleanup();
            };
            const onMessage = (value: unknown) => Queue.offerUnsafe(queue, value);
            const onError = (cause: Error) =>
              fail(new SupervisorStartError({ message: cause.message }));
            const onExit = (code: number | null) =>
              fail(new SupervisorStartError({ message: `Supervisor exited with code ${code}` }));
            child.on("message", onMessage);
            child.on("error", onError);
            child.on("exit", onExit);
            return cleanup;
          }),
          (cleanup) => Effect.sync(cleanup),
        ),
      );
      const pull = yield* Stream.toPull(events);
      while (true) {
        const chunk = yield* pull.pipe(
          Effect.mapError((error) =>
            error instanceof SupervisorStartError
              ? error
              : new SupervisorStartError({ message: "Supervisor event stream ended" }),
          ),
        );
        const event = yield* decodeSupervisorEvent(chunk[0]);
        return event;
      }
    }),
  );

/** Parent-side launcher for the managed supervisor. */
export const supervisorLayer = (
  input: SupervisorStartMessage,
  entryPoint: string,
): Effect.Effect<
  Layer.Layer<
    import("./Stack.ts").Stack,
    DaemonUpgradeRequired | StackRpcProtocolError | StackRpcTransportError
  >,
  | SupervisorStartError
  | DaemonUpgradeRequired
  | import("./managed/model.ts").InvalidManagedStackNameError,
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
      if (response.owner.daemonCliVersion !== input.cliVersion) {
        return yield* Effect.fail(
          new DaemonUpgradeRequired({
            stackId: input.stackId,
            oldCliVersion: response.owner.daemonCliVersion,
            newCliVersion: input.cliVersion,
            state: response.owner.state,
            ready: response.owner.ready,
          }),
        );
      }
      if (response.owner.state !== "running" || !response.owner.ready) {
        return yield* Effect.fail(
          new SupervisorStartError({
            message: STACK_STOPPED_DURING_STARTUP,
          }),
        );
      }
      child.unref();
      detached = true;
      return RemoteStack.layer(response.endpoint, {
        owner: response.owner,
        cliVersion: input.cliVersion,
        stackId: input.stackId,
      }).pipe(Layer.provide(Layer.succeed(HttpTransportClient, client)));
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
  Layer.Layer<Stack, DaemonUpgradeRequired | StackRpcProtocolError | StackRpcTransportError>,
  | SupervisorStartError
  | DaemonUpgradeRequired
  | import("./managed/model.ts").InvalidManagedStackNameError,
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
        cliVersion: input.cliVersion,
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
