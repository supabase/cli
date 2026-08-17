import { fork, type ChildProcess } from "node:child_process";
import { Context, Data, Duration, Effect, Fiber, Layer, Schedule, Scope, Schema } from "effect";
import { HttpServer } from "effect/unstable/http";
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
import { ManagedStackManager, type ManagedStackStartResult } from "./managed/manager.ts";
import { managedStackLaunchSchema } from "./managed/document.ts";
import { deriveStackId } from "./managed/environment.ts";
import { validateManagedStackName, type ManagedPortIntentDocument } from "./managed/model.ts";
import { managedStackPaths } from "./managed/paths.ts";
import { PORT_FIELDS, type PortField, type PortSet } from "./PortCatalog.ts";
import { SERVICE_NAMES } from "./ServiceCatalog.ts";
import { dockerContainerName } from "./StackIdentity.ts";
import type { PortAllocationError, PortLease } from "./PortAllocator.ts";
import { resolveConfig, type DaemonConfigInput } from "./StackConfigResolver.ts";
import type { ResolvedDaemonConfig } from "./StackConfig.ts";
import { HttpTransportClient } from "./HttpTransportClient.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { terminateChildProcess } from "./terminateChild.ts";
import { dockerForceRemove } from "./cleanup.ts";

/** The only message sent across the detached child IPC boundary. */
export interface SupervisorStartMessage {
  readonly type: "start";
  readonly workspacePath: string;
  readonly stackName: string;
  readonly stateRoot: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly portIntents: ManagedPortIntentDocument;
  readonly launch?: import("./managed/document.ts").ManagedStackDocument["launch"];
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
  readonly launch?: import("./managed/document.ts").ManagedStackDocument["launch"];
}

const supervisorPortIntentSchema = Schema.Struct({
  activeFields: Schema.Array(Schema.Literals(PORT_FIELDS)),
  disabledFields: Schema.optionalKey(Schema.Array(Schema.Literals(PORT_FIELDS))),
  document: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const supervisorStartMessageSchema = Schema.Struct({
  type: Schema.Literal("start"),
  workspacePath: Schema.String,
  stackName: Schema.String,
  stateRoot: Schema.String,
  config: Schema.Record(Schema.String, Schema.Unknown),
  portIntents: supervisorPortIntentSchema,
  launch: Schema.optionalKey(managedStackLaunchSchema),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isControlEndpoint = (value: unknown): value is ControlEndpoint =>
  isRecord(value) &&
  typeof value.hostname === "string" &&
  typeof value.port === "number" &&
  typeof value.url === "string";

const decodeSupervisorStartMessage = (value: unknown): SupervisorStartMessage => {
  return Schema.decodeUnknownSync(supervisorStartMessageSchema)(value);
};

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

const toDaemonConfig = (value: Readonly<Record<string, unknown>>): DaemonConfigInput | undefined =>
  typeof value.cwd === "string" ? { ...value, cwd: value.cwd } : undefined;

export class SupervisorStartError extends Data.TaggedError("SupervisorStartError")<{
  readonly message: string;
}> {}

class SupervisorOwnerUnavailableError extends Data.TaggedError("SupervisorOwnerUnavailableError")<{
  readonly retry: boolean;
  readonly detail: string;
}> {}

class SupervisorOwnerReacquirePending extends Data.TaggedError(
  "SupervisorOwnerReacquirePending",
)<{}> {}

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
          retry: status.state === "starting",
          detail: `Attached supervisor owner is ${status.state} before becoming ready`,
        }),
      );
    }),
    Effect.retry({
      schedule: Schedule.spaced("25 millis").pipe(
        Schedule.tap(({ attempt }) => (attempt === 1 ? onWaiting : Effect.void)),
      ),
      while: (error) => error._tag === "SupervisorOwnerUnavailableError" && error.retry,
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
    never,
    ControlTransport | import("effect").FileSystem.FileSystem | import("effect").Path.Path
  >;
}

const receiveStartMessage = (): Effect.Effect<SupervisorStartMessage, SupervisorStartError> =>
  Effect.callback((resume) => {
    const onMessage = (value: unknown) => {
      cleanup();
      try {
        resume(Effect.succeed(decodeSupervisorStartMessage(value)));
      } catch (cause) {
        resume(Effect.fail(new SupervisorStartError({ message: causeMessage(cause) })));
      }
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

const leaseFacade = (lease: {
  readonly ports: PortSet;
  readonly reserve: (fields: ReadonlyArray<PortField>) => Effect.Effect<void, PortAllocationError>;
  readonly release: (fields: ReadonlyArray<PortField>) => Effect.Effect<void>;
  readonly releaseAll: Effect.Effect<void>;
}): PortLease => ({
  ports: lease.ports,
  reserve: lease.reserve,
  release: lease.release,
  releaseAll: lease.releaseAll,
});

const startDaemon = (input: {
  readonly config: ResolvedDaemonConfig;
  readonly lease: PortLease;
  readonly ownership: ControlOwnership;
  readonly platform: SupervisorPlatform;
  readonly scope: Scope.Scope;
  readonly launchUpdate?: (
    launch: NonNullable<import("./managed/document.ts").ManagedStackDocument["launch"]>,
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
  | Scope.Scope
> => {
  let owner: ControlOwnership | undefined;
  let managerService: ManagedStackManager["Service"] | undefined;
  return Effect.gen(function* () {
    yield* validateManagedStackName(input.stackName);
    const manager = yield* ManagedStackManager.pipe(
      Effect.provide(platform.managerLayer(input.stateRoot)),
    );
    managerService = manager;
    const configInput = toDaemonConfig(input.config);
    if (configInput === undefined) {
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Supervisor config is missing cwd" }),
      );
    }
    const discovery = yield* manager.ensureWorkspace(input.workspacePath);
    const stackId = deriveStackId(discovery.identity, input.stackName);
    const initialAcquisition = yield* acquireControl({ stackId });
    const reacquireAfterDeath = (): Effect.Effect<ControlAcquisition, unknown, Scope.Scope> =>
      manager.acquireControl(stackId).pipe(
        Effect.flatMap((candidate): Effect.Effect<ControlAcquisition, unknown, Scope.Scope> => {
          if (candidate._tag === "Owned") return Effect.succeed(candidate);
          return candidate.ownerStatus.pipe(
            Effect.flatMap(
              (status): Effect.Effect<never, unknown> =>
                status.state === "starting"
                  ? Effect.fail(new SupervisorOwnerReacquirePending())
                  : Effect.fail(
                      new SupervisorStartError({
                        message: `Attached supervisor owner is ${status.state} after disconnect`,
                      }),
                    ),
            ),
            Effect.catch((error) =>
              error instanceof ControlTransportError && error.reason === "unreachable"
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
    const attachedResolution =
      initialAcquisition._tag === "Attached"
        ? awaitOwnerReady(
            initialAcquisition,
            platform.onAttachedBeforeReady?.() ?? Effect.void,
          ).pipe(
            Effect.as(initialAcquisition),
            Effect.catch((error) =>
              error instanceof ControlTransportError && error.reason === "unreachable"
                ? reacquireAfterDeath()
                : Effect.fail(error),
            ),
          )
        : Effect.succeed(initialAcquisition);
    const acquisition = yield* attachedResolution.pipe(
      Effect.timeout(platform.resolutionTimeout ?? SUPERVISOR_STARTUP_TIMEOUT),
      Effect.catch((error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        error._tag === "TimeoutError"
          ? Effect.fail(
              new SupervisorStartError({
                message: "Timed out resolving attached supervisor owner",
              }),
            )
          : Effect.fail(error),
      ),
    );
    if (acquisition._tag === "Attached") {
      yield* sendMessage({ type: "started", endpoint: acquisition.endpoint, attached: true });
      process.disconnect?.();
      return;
    }
    const ownership = acquisition;
    owner = ownership;
    const startup = Effect.gen(function* () {
      const existing = yield* manager.inspectStack(stackId);
      if (
        existing !== undefined &&
        (existing.lifecycle === "starting" ||
          existing.lifecycle === "running" ||
          existing.lifecycle === "failed" ||
          existing.lifecycle === "deleting")
      ) {
        yield* dockerForceRemove(
          SERVICE_NAMES.map((service) => dockerContainerName(service, `id-${stackId}`)),
        );
      }
      const started: ManagedStackStartResult = yield* manager.startStack({
        workspacePath: input.workspacePath,
        stackName: input.stackName,
        portDocument: input.portIntents,
        ownership,
        lifecycle: "starting",
        launch: input.launch,
      });
      const resolved = yield* Effect.tryPromise({
        try: () =>
          resolveConfig(
            {
              ...configInput,
              projectDir: configInput.projectDir ?? input.workspacePath,
              stackRoot: managedStackPaths(input.stateRoot, started.stack.id).root,
              runtimeRoot: managedStackPaths(input.stateRoot, started.stack.id).runtime,
              instanceId: started.stack.id,
            },
            { portAllocator: () => Effect.succeed(started.lease.ports) },
          ),
        catch: (cause) => cause,
      });
      const config: ResolvedDaemonConfig = {
        ...resolved,
        name: input.stackName,
        projectDir: configInput.projectDir ?? input.workspacePath,
      };
      yield* manager.recordLifecycle(ownership, {
        stackId: started.stack.id,
        lifecycle: "starting",
      });
      const built = yield* startDaemon({
        config,
        lease: leaseFacade(started.lease),
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
    if (startupResult._tag === "stopped") {
      const current = yield* manager.inspectStack(stackId);
      if (current !== undefined) {
        yield* manager.recordLifecycle(ownership, { stackId, lifecycle: "stopped" });
      }
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
      if (owner === undefined || managerService === undefined) return Effect.failCause(cause);
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
  SupervisorStartError | unknown,
  ControlTransport | import("effect").FileSystem.FileSystem | import("effect").Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const input = yield* receiveStartMessage();
      yield* Effect.matchCauseEffect(runManaged(input, platform, scope), {
        onFailure: (cause) =>
          sendMessage({ type: "error", message: causeMessage(cause) }).pipe(
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
        Effect.mapError(
          () => new SupervisorStartError({ message: "Timed out waiting for supervisor startup" }),
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
        detached
          ? Effect.void
          : Effect.promise(() => terminateChildProcess(child)).pipe(Effect.ignore),
      ),
    );
  });

export const managedDaemonLayer = (
  input: ManagedDaemonStartInput,
  entryPoint: string,
): Effect.Effect<
  Layer.Layer<Stack>,
  SupervisorStartError | import("./managed/model.ts").InvalidManagedStackNameError,
  HttpTransportClient
> =>
  supervisorLayer(
    {
      type: "start",
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
