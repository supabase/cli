import { fork, type ChildProcess } from "node:child_process";
import {
  Cause,
  Context,
  Data,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Result,
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
import { SupervisorLifecycle } from "./SupervisorLifecycle.ts";
import {
  SupervisorErrorEventSchema,
  SupervisorReplacingEventSchema,
  SupervisorReplacementAckCommandSchema,
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
  type ControlOwnerStatus,
  type ControlApplication,
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
import type { BuildIdentityValue } from "./BuildIdentity.ts";
import { CONTROL_PROTOCOL_VERSION } from "./DaemonProtocol.ts";
import {
  DaemonUpgradeRequired,
  StackBuildError,
  StackRpcProtocolError,
  StackRpcTransportError,
  UpgradePreflightError,
  UpgradeRestartError,
  SupervisorStartError,
} from "./errors.ts";
import {
  replaceIncompatibleOwner,
  runtimeSelectionForLaunch,
  applyNativeDefaults,
  SUPERVISOR_REPLACEMENT_PHASE_TIMEOUT,
} from "./SupervisorReplacement.ts";
import type {
  SupervisorErrorMessage,
  SupervisorReplacingMessage,
  SupervisorStartMessage,
  SupervisorStartedMessage,
} from "./SupervisorProtocol.ts";
export type { SupervisorReplacingMessage, SupervisorStartMessage, SupervisorStartedMessage };
export { SupervisorStartError } from "./errors.ts";
type SupervisorMessage =
  | SupervisorStartedMessage
  | SupervisorReplacingMessage
  | SupervisorErrorMessage;
/** Input shape for the public managed launcher. */
export interface ManagedDaemonStartInput {
  readonly buildIdentity: BuildIdentityValue;
  readonly incompatibleOwnerPolicy: "replace" | "fail";
  readonly workspacePath: string;
  readonly stackName: string;
  readonly stateRoot: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly portIntents: ManagedPortIntentDocument;
  readonly launch?: ManagedStackLaunchInput;
  /** Parent-only callback invoked before an incompatible owner is fenced. */
  readonly onReplacing?: (event: SupervisorReplacingMessage) => Effect.Effect<void>;
}

const supervisorStartMessageSchema = SupervisorStartCommandSchema;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isControlOwnership = (value: ControlAcquisition): value is ControlOwnership =>
  Predicate.isTagged(value, "Owned");

const isControlAttached = (value: ControlAcquisition): value is ControlAttached =>
  Predicate.isTagged(value, "Attached");

const startedOwnerDescriptor = (status: ControlOwnerStatus): SupervisorStartedMessage["owner"] => ({
  ownershipId: status.ownershipId,
  ownerSessionId: status.ownerSessionId,
  controlProtocolVersion: status.controlProtocolVersion,
  daemonCliVersion: status.daemonCliVersion,
  daemonBuildId: status.daemonBuildId,
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
// Preflight, old-session stop, and endpoint reacquisition each have one phase
// budget before the normal child startup budget begins.
const SUPERVISOR_REPLACEMENT_HANDSHAKE_TIMEOUT = Duration.sum(
  Duration.times(SUPERVISOR_REPLACEMENT_PHASE_TIMEOUT, 3),
  SUPERVISOR_HANDSHAKE_TIMEOUT,
);

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

/**
 * Wait for the parent to acknowledge a replacement notification. The child
 * installs this listener before publishing `replacing`, so the acknowledgement
 * cannot race the listener handoff while the parent callback is running.
 */
const receiveReplacementAck = (): Effect.Effect<void, SupervisorStartError> =>
  Effect.callback((resume) => {
    let settled = false;
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const finish = (effect: Effect.Effect<void, SupervisorStartError>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(effect);
    };
    const onMessage = (value: unknown) => {
      if (isRecord(value) && value.type === "test-stage") return;
      const decoded = Schema.decodeUnknownOption(SupervisorReplacementAckCommandSchema)(value);
      if (Option.isSome(decoded)) {
        finish(Effect.void);
        return;
      }
      finish(
        Schema.decodeUnknownEffect(SupervisorReplacementAckCommandSchema)(value).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => new SupervisorStartError({ message: causeMessage(cause) })),
        ),
      );
    };
    const onDisconnect = () =>
      finish(
        Effect.fail(
          new SupervisorStartError({
            message: "Supervisor parent disconnected during replacement",
          }),
        ),
      );
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    return Effect.sync(cleanup);
  });

const sendMessage = (message: SupervisorMessage): Effect.Effect<void, SupervisorStartError> =>
  Effect.gen(function* () {
    const schema =
      message.type === "error"
        ? SupervisorErrorEventSchema
        : message.type === "replacing"
          ? SupervisorReplacingEventSchema
          : SupervisorStartedEventSchema;
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
): Effect.Effect<
  SupervisorStartedMessage | SupervisorReplacingMessage,
  SupervisorStartError | DaemonUpgradeRequired
> =>
  Schema.decodeUnknownEffect(SupervisorReplacingEventSchema)(value).pipe(
    Effect.map((event): SupervisorReplacingMessage => event),
    Effect.catch(() => decodeSupervisorStartedOrError(value)),
  );

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
          (event): Effect.Effect<never, DaemonUpgradeRequired | SupervisorStartError> =>
            event.errorCode === "DAEMON_UPGRADE_REQUIRED" &&
            event.stackId !== undefined &&
            event.oldCliVersion !== undefined &&
            event.oldBuildId !== undefined &&
            event.newCliVersion !== undefined &&
            event.newBuildId !== undefined
              ? Effect.fail(
                  new DaemonUpgradeRequired({
                    stackId: event.stackId,
                    oldCliVersion: event.oldCliVersion,
                    oldBuildId: event.oldBuildId,
                    newCliVersion: event.newCliVersion,
                    newBuildId: event.newBuildId,
                  }),
                )
              : Effect.fail(new SupervisorStartError({ message: event.message })),
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
      message: `Daemon build mismatch for ${error.stackId}: expected ${error.newBuildId}, observed ${error.oldBuildId}`,
      errorCode: "DAEMON_UPGRADE_REQUIRED",
      stackId: error.stackId,
      oldCliVersion: error.oldCliVersion,
      oldBuildId: error.oldBuildId,
      newCliVersion: error.newCliVersion,
      newBuildId: error.newBuildId,
    };
  }
  if (error instanceof UpgradeRestartError) {
    return { type: "error", message: `UpgradeRestartError: ${error.detail}` };
  }
  if (error instanceof UpgradePreflightError) {
    return { type: "error", message: `UpgradePreflightError: ${error.detail}` };
  }
  return { type: "error", message: causeMessage(error) };
};

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
        : yield* input.platform.runtimeLayer({ config: input.config, lease: input.lease });
    const appServices = yield* Layer.buildWithScope(appLayer, input.scope);
    const localStack = Context.get(appServices, Stack);
    const localLifecycle = Context.get(appServices, LocalStackLifecycle);
    return { stack: localStack, localLifecycle };
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
  let lifecycle: SupervisorLifecycle["Service"] | undefined;
  let replacingIncompatibleOwner = false;
  let oldSessionEnded = false;
  return Effect.gen(function* () {
    const controlTransport = yield* ControlTransport;
    yield* validateManagedStackName(input.stackName);
    const configInput = toDaemonConfig(input.config);
    if (configInput === undefined) {
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Supervisor config is missing cwd" }),
      );
    }
    const supervisorLifecycle = yield* SupervisorLifecycle.make({
      ownershipId: input.stackId,
      ownerSessionId: crypto.randomUUID(),
      daemonCliVersion: input.buildIdentity.cliVersion,
      daemonBuildId: input.buildIdentity.buildId,
    });
    lifecycle = supervisorLifecycle;
    const launchUpdater: StackLaunchUpdater = {
      update: (stackId: string, launch: StackLaunchUpdateRpc) => {
        const currentOwner = owner;
        const currentManager = managerService;
        if (currentOwner === undefined || currentManager === undefined) {
          return Effect.fail(
            new StackBuildError({ detail: "Managed launch updates require an owned supervisor" }),
          );
        }
        return Schema.decodeUnknownEffect(managedStackLaunchUpdateSchema)(launch).pipe(
          Effect.mapError((cause) => new StackBuildError({ detail: causeMessage(cause) })),
          Effect.flatMap((decoded) =>
            currentManager.updateLaunch(currentOwner, { stackId, launch: decoded }),
          ),
          Effect.mapError((cause) => new StackBuildError({ detail: causeMessage(cause) })),
          Effect.asVoid,
        );
      },
    };
    const controlApplication: ControlApplication = {
      app: yield* makeSupervisorControlApplication(supervisorLifecycle, launchUpdater),
    };
    let initialAcquisition = yield* acquireControl({
      stackId: input.stackId,
      initialStatus: yield* supervisorLifecycle.currentStatus,
      application: controlApplication,
    });
    if (isControlOwnership(initialAcquisition)) {
      owner = initialAcquisition;
    }
    const manager = yield* ManagedStackManager.pipe(
      Effect.provide(platform.managerLayer(input.stateRoot)),
      Effect.catchCause((cause) =>
        supervisorLifecycle
          .setClose(owner?.close ?? Effect.void)
          .pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );
    managerService = manager;
    const registerOwnerClose = (ownedOwner: ControlOwnership) =>
      supervisorLifecycle.setClose(
        Effect.ensuring(
          manager.inspectStack(input.stackId).pipe(
            Effect.flatMap((current) =>
              current?.lifecycle === "starting" || current?.lifecycle === "running"
                ? manager
                    .recordLifecycle(ownedOwner, {
                      stackId: input.stackId,
                      lifecycle: "stopped",
                    })
                    .pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
          ownedOwner.close,
        ),
      );
    if (owner !== undefined) yield* registerOwnerClose(owner);
    const discovered = manager
      .ensureWorkspace(input.workspacePath)
      .pipe(Effect.map((discovery) => ({ _tag: "discovered" as const, discovery })));
    const discoveryResult = yield* isControlOwnership(initialAcquisition)
      ? Effect.raceFirst(
          discovered,
          supervisorLifecycle.awaitShutdown.pipe(Effect.as({ _tag: "stopped" as const })),
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
    let replacementConfigInput = configInput;
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
    const initiallyAttached = isControlAttached(initialAcquisition);
    const reacquireAfterDeath = () =>
      Effect.gen(function* () {
        const status = yield* supervisorLifecycle.currentStatus;
        return yield* acquireControl({
          stackId,
          initialStatus: status,
          application: controlApplication,
        }).pipe(
          Effect.provideService(ControlTransport, controlTransport),
          Effect.flatMap(
            (candidate): Effect.Effect<ControlAcquisition, SupervisorOwnerReacquirePending> => {
              if (isControlOwnership(candidate)) return Effect.succeed(candidate);
              return candidate.observedStatus.daemonBuildId === input.buildIdentity.buildId
                ? Effect.succeed(candidate)
                : Effect.fail(new SupervisorOwnerReacquirePending());
            },
          ),
          Effect.retry({
            schedule: Schedule.spaced("25 millis"),
            while: (error) => error instanceof SupervisorOwnerReacquirePending,
          }),
        );
      });
    if (isControlAttached(initialAcquisition)) {
      const attachedStatus = initialAcquisition.observedStatus;
      attachedOwnerWasStopping = attachedStatus.state === "stopping";
      if (attachedStatus.daemonBuildId !== input.buildIdentity.buildId) {
        replacingIncompatibleOwner = true;
        const replacement = yield* replaceIncompatibleOwner({
          stackId,
          oldOwner: initialAcquisition,
          input,
          configInput,
          manager,
          controlTransport,
          resolutionTimeout: platform.resolutionTimeout ?? SUPERVISOR_STARTUP_TIMEOUT,
          authorize: (event) =>
            Effect.gen(function* () {
              const replacementAckFiber = yield* receiveReplacementAck().pipe(
                Effect.forkChild({ startImmediately: true }),
              );
              yield* sendMessage(event);
              yield* Fiber.join(replacementAckFiber);
            }),
          reacquire: () =>
            reacquireAfterDeath().pipe(
              Effect.catchTag("SupervisorOwnerReacquirePending", () => Effect.never),
            ),
        });
        oldSessionEnded = replacement.oldSessionEnded;
        attachedOwnerWasStopping = replacement.attachedOwnerWasStopping;
        replacementConfigInput = replacement.effectiveConfigInput;
        initialAcquisition = replacement.acquisition;
      } else if (!(attachedStatus.state === "running" && attachedStatus.ready)) {
        yield* awaitOwnerReady(
          initialAcquisition,
          platform.onAttachedBeforeReady?.() ?? Effect.void,
        ).pipe(
          Effect.timeout(platform.resolutionTimeout ?? SUPERVISOR_STARTUP_TIMEOUT),
          Effect.catch((error) =>
            Predicate.isTagged(error, "TimeoutError")
              ? Effect.fail(
                  new SupervisorStartError({
                    message: "Timed out resolving attached supervisor owner",
                  }),
                )
              : Effect.fail(error),
          ),
          Effect.catchTag("ControlTransportError", (error) =>
            error.reason === "unreachable"
              ? reacquireAfterDeath().pipe(
                  Effect.tap((next) =>
                    Effect.sync(() => {
                      initialAcquisition = next;
                    }),
                  ),
                  Effect.asVoid,
                )
              : Effect.fail(error),
          ),
        );
      }
    }
    const acquisition = initialAcquisition;
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
      const attachedStatus = yield* acquisition.ownerStatus;
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
    // A mismatch replacement starts attached and only acquires this new
    // owner after the old session has ended. Register the close capability
    // at that handoff before startup can publish or accept /stop.
    yield* registerOwnerClose(ownership);
    const ownedExisting = yield* manager.inspectStack(stackId);
    if (initiallyAttached && !attachedOwnerWasStopping) {
      if (ownedExisting?.lifecycle === "stopped" && ownedExisting.stopIntent === "explicit") {
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
        ? applyNativeDefaults(replacementConfigInput)
        : replacementConfigInput;
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
    const launchInput =
      replacingIncompatibleOwner && ownedExisting !== undefined
        ? ownedExisting.launch
        : (input.launch ?? { versions: {} });
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
      if (lifecycle !== undefined) yield* lifecycle.publishStack(built.stack);
      if (lifecycle !== undefined) {
        yield* Effect.forkIn(
          built.localLifecycle.awaitDisposed.pipe(
            Effect.andThen(lifecycle.fail("Local stack disposed unexpectedly")),
            Effect.andThen(lifecycle.requestShutdown("dispose")),
            Effect.catchCause(() => Effect.void),
          ),
          scope,
        );
      }
      yield* manager.recordLifecycle(ownership, {
        stackId: started.stack.id,
        lifecycle: "running",
        runtime: {
          pid: process.pid,
          controlEndpoint: ownership.endpoint.url,
          protocolVersion: CONTROL_PROTOCOL_VERSION,
        },
      });
      const publishedStatus = yield* supervisorLifecycle.currentStatus;
      yield* sendMessage({
        type: "started",
        endpoint: ownership.endpoint,
        owner: startedOwnerDescriptor(publishedStatus),
        attached: false,
      });
      process.disconnect?.();
      return { started, built };
    });
    const startupResult = yield* Effect.raceFirst(
      startup.pipe(Effect.map((result) => ({ _tag: "started" as const, ...result }))),
      (lifecycle?.awaitShutdown ?? Effect.never).pipe(Effect.as({ _tag: "stopped" as const })),
    );
    if (Predicate.isTagged(startupResult, "stopped")) {
      yield* sendMessage({ type: "error", message: STACK_STOPPED_DURING_STARTUP });
      return;
    }
    const shutdown = yield* Effect.raceFirst(
      waitForSignal().pipe(Effect.as("signal" as const)),
      (lifecycle?.awaitShutdown ?? Effect.never).pipe(Effect.as("shutdown" as const)),
    );
    if (lifecycle !== undefined && shutdown === "signal") {
      yield* lifecycle.requestShutdown("signal");
    }
  }).pipe(
    Effect.catchCause((cause) => {
      const typed = Cause.findError(cause);
      const failure = Result.isSuccess(typed) ? typed.success : undefined;
      if (failure instanceof SupervisorStartError && failure.reason === "owner-stopped") {
        return Effect.failCause(cause);
      }
      const canMapRestart =
        replacingIncompatibleOwner &&
        oldSessionEnded &&
        failure !== undefined &&
        !Cause.hasDies(cause) &&
        !Cause.hasInterrupts(cause);
      const failureDetail = failure === undefined ? causeMessage(cause) : causeMessage(failure);
      const finalizeFailure =
        lifecycle === undefined
          ? Effect.void
          : lifecycle
              .setClose(owner?.close ?? Effect.void)
              .pipe(
                Effect.andThen(lifecycle.fail(failureDetail)),
                Effect.andThen(lifecycle.requestShutdown("startup-failure")),
              );
      if (!claimedStack || owner === undefined || managerService === undefined) {
        return finalizeFailure.pipe(
          Effect.andThen(
            canMapRestart
              ? Effect.fail(
                  new UpgradeRestartError({
                    stackId: input.stackId,
                    newBuildId: input.buildIdentity.buildId,
                    detail: failureDetail,
                  }),
                )
              : Effect.failCause(cause),
          ),
        );
      }
      return managerService
        .recordLifecycle(owner, {
          stackId: owner.ownershipId,
          lifecycle: "failed",
        })
        .pipe(Effect.andThen(finalizeFailure))
        .pipe(
          Effect.matchCauseEffect({
            onFailure: () =>
              canMapRestart
                ? Effect.fail(
                    new UpgradeRestartError({
                      stackId: input.stackId,
                      newBuildId: input.buildIdentity.buildId,
                      detail: causeMessage(failure),
                    }),
                  )
                : Effect.failCause(cause),
            onSuccess: () =>
              canMapRestart
                ? Effect.fail(
                    new UpgradeRestartError({
                      stackId: input.stackId,
                      newBuildId: input.buildIdentity.buildId,
                      detail: causeMessage(failure),
                    }),
                  )
                : Effect.failCause(cause),
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
  SupervisorStartError | unknown,
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
          sendMessage(supervisorErrorMessage(cause)).pipe(Effect.andThen(Effect.failCause(cause))),
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

const sendReplacementAck = (child: ChildProcess): Effect.Effect<void, SupervisorStartError> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(SupervisorReplacementAckCommandSchema)({
      type: "replacement-ack",
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
  onReplacing?: (event: SupervisorReplacingMessage) => Effect.Effect<void>,
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
        // Test/runtime stage notifications share the child IPC channel but
        // are intentionally outside the supervisor control protocol.
        if (isRecord(chunk[0]) && chunk[0].type === "test-stage") continue;
        const event = yield* decodeSupervisorEvent(chunk[0]);
        if (event.type === "started") return event;
        if (onReplacing !== undefined) yield* onReplacing(event);
        yield* sendReplacementAck(child);
      }
    }),
  );

/** Parent-side launcher for the managed supervisor. */
export const supervisorLayer = (
  input: SupervisorStartMessage,
  entryPoint: string,
  onReplacing?: (event: SupervisorReplacingMessage) => Effect.Effect<void>,
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
      const responseFiber = yield* waitForStarted(child, onReplacing).pipe(
        Effect.timeout(
          input.incompatibleOwnerPolicy === "replace"
            ? SUPERVISOR_REPLACEMENT_HANDSHAKE_TIMEOUT
            : SUPERVISOR_HANDSHAKE_TIMEOUT,
        ),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new SupervisorStartError({ message: "Timed out waiting for supervisor startup" }),
          ),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* sendStart(child, input);
      const response = yield* Fiber.join(responseFiber);
      if (response.owner.daemonBuildId !== input.buildIdentity.buildId) {
        return yield* Effect.fail(
          new DaemonUpgradeRequired({
            stackId: input.stackId,
            oldCliVersion: response.owner.daemonCliVersion,
            oldBuildId: response.owner.daemonBuildId,
            newCliVersion: input.buildIdentity.cliVersion,
            newBuildId: input.buildIdentity.buildId,
          }),
        );
      }
      child.unref();
      detached = true;
      return RemoteStack.layer(response.endpoint, {
        owner: response.owner,
        buildIdentity: input.buildIdentity,
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
        buildIdentity: input.buildIdentity,
        incompatibleOwnerPolicy: input.incompatibleOwnerPolicy,
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
      input.onReplacing,
    );
  });
