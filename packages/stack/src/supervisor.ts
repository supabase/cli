import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  Context,
  Data,
  Effect,
  Fiber,
  Layer,
  Option,
  Schedule,
  Scope,
  Schema,
  Stream,
} from "effect";
import { HttpServer } from "effect/unstable/http";
import type { PlatformFactory } from "./createStack.ts";
import { DaemonServer } from "./DaemonServer.ts";
import { Stack } from "./Stack.ts";
import { foregroundDaemonLayer, foregroundLayer } from "./layers.ts";
import {
  acquireControl,
  type ControlAttached,
  type ControlEndpoint,
  type ControlOwnership,
  type ControlTransport,
} from "./managed/control.ts";
import { ManagedStackManager, type ManagedStackStartResult } from "./managed/manager.ts";
import { deriveStackId } from "./managed/environment.ts";
import type { ManagedPortIntentDocument } from "./managed/model.ts";
import { managedStackPaths } from "./managed/paths.ts";
import { PORT_FIELDS, type PortField, type PortSet } from "./PortCatalog.ts";
import { SERVICE_NAMES } from "./ServiceCatalog.ts";
import { dockerContainerName } from "./StackIdentity.ts";
import type { PortAllocationError, PortLease } from "./PortAllocator.ts";
import { reservePortSet } from "./PortAllocator.ts";
import {
  resolveConfig,
  resolveDaemonConfig,
  type DaemonConfigInput,
} from "./StackConfigResolver.ts";
import type { ResolvedDaemonConfig } from "./StackConfig.ts";
import { StateManager, singleStackStateManagerPaths, type StackState } from "./StateManager.ts";
import { UnixHttpClient } from "./UnixHttpClient.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { terminateChildProcess } from "./terminateChild.ts";
import { dockerForceRemove } from "./cleanup.ts";

/** Explicit substitutions used by integration tests. Never inferred from paths. */
export type SupervisorTestMode =
  | "bind-all"
  | "fail-after-bind"
  | "hold-reservations"
  | "hold-start"
  | "hold-delete";

/** The only message sent across the detached child IPC boundary. */
export interface SupervisorStartMessage {
  readonly type: "start";
  readonly operation?: "start" | "delete";
  readonly mode: "managed" | "ephemeral";
  readonly stackId?: string;
  readonly ownershipId?: string;
  readonly workspacePath: string;
  readonly stackName: string;
  readonly stateRoot: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly effectiveConfig?: Readonly<Record<string, unknown>>;
  readonly portIntents?: unknown;
  readonly socketPath?: string;
  readonly testMode?: SupervisorTestMode;
}

export interface SupervisorStartedMessage {
  readonly type: "started";
  readonly endpoint: ControlEndpoint;
  readonly state?: StackState;
  readonly attached?: boolean;
}

interface SupervisorErrorMessage {
  readonly type: "error";
  readonly message: string;
}

type SupervisorMessage = SupervisorStartedMessage | SupervisorErrorMessage;
/** Compatibility input shape for the public managed launcher. */
export interface ManagedDaemonStartInput {
  readonly workspacePath: string;
  readonly stackName: string;
  readonly stateRoot: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly effectiveConfig: Readonly<Record<string, unknown>>;
  readonly valueOrigins?: ManagedPortIntentDocument["valueOrigins"];
  readonly socketPath?: string;
  readonly stackId?: string;
}

const supervisorPortIntentSchema = Schema.Struct({
  activeFields: Schema.Array(Schema.String),
  disabledFields: Schema.optionalKey(Schema.Array(Schema.String)),
  document: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  valueOrigins: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.Array(Schema.String),
        source: Schema.Literals(["environment", "local", "remote"]),
      }),
    ),
  ),
});

const supervisorStartMessageSchema = Schema.Struct({
  type: Schema.Literal("start"),
  operation: Schema.optionalKey(Schema.Literals(["start", "delete"])),
  mode: Schema.Literals(["managed", "ephemeral"]),
  stackId: Schema.optionalKey(Schema.String),
  ownershipId: Schema.optionalKey(Schema.String),
  workspacePath: Schema.String,
  stackName: Schema.String,
  stateRoot: Schema.String,
  config: Schema.Record(Schema.String, Schema.Unknown),
  effectiveConfig: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  portIntents: Schema.optionalKey(supervisorPortIntentSchema),
  socketPath: Schema.optionalKey(Schema.String),
  testMode: Schema.optionalKey(
    Schema.Literals([
      "bind-all",
      "fail-after-bind",
      "hold-reservations",
      "hold-start",
      "hold-delete",
    ]),
  ),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isControlEndpoint = (value: unknown): value is ControlEndpoint =>
  isRecord(value) &&
  value._tag === "Loopback" &&
  typeof value.hostname === "string" &&
  typeof value.host === "string" &&
  typeof value.port === "number" &&
  typeof value.url === "string" &&
  typeof value.path === "string";

const decodeSupervisorStartMessage = (value: unknown): SupervisorStartMessage => {
  return Schema.decodeUnknownSync(supervisorStartMessageSchema)(value);
};

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

const isPortField = (value: string): value is PortField =>
  PORT_FIELDS.some((field) => field === value);

const toDaemonConfig = (value: Readonly<Record<string, unknown>>): DaemonConfigInput | undefined =>
  typeof value.cwd === "string" ? { ...value, cwd: value.cwd } : undefined;

const toPortDocument = (
  value: unknown,
  fallback: Readonly<Record<string, unknown>>,
): ManagedPortIntentDocument => {
  if (!isRecord(value)) return { activeFields: [], document: fallback };
  const activeFields = Array.isArray(value.activeFields)
    ? value.activeFields.filter(
        (field): field is PortField => typeof field === "string" && isPortField(field),
      )
    : [];
  const disabledFields = Array.isArray(value.disabledFields)
    ? value.disabledFields.filter(
        (field): field is PortField => typeof field === "string" && isPortField(field),
      )
    : undefined;
  const document = isRecord(value.document) ? value.document : fallback;
  const valueOrigins: Array<{
    readonly path: ReadonlyArray<string>;
    readonly source: "environment" | "local" | "remote";
  }> = [];
  if (Array.isArray(value.valueOrigins)) {
    for (const origin of value.valueOrigins) {
      if (!isRecord(origin) || !Array.isArray(origin.path) || typeof origin.source !== "string")
        continue;
      const path = origin.path.filter((entry): entry is string => typeof entry === "string");
      if (
        origin.source !== "environment" &&
        origin.source !== "local" &&
        origin.source !== "remote"
      )
        continue;
      valueOrigins.push({ path, source: origin.source });
    }
  }
  return {
    activeFields,
    document,
    ...(disabledFields === undefined ? {} : { disabledFields }),
    ...(valueOrigins.length === 0 ? {} : { valueOrigins }),
  };
};

export class SupervisorStartError extends Data.TaggedError("SupervisorStartError")<{
  readonly message: string;
}> {}

export class ManagedDaemonStartError extends Data.TaggedError("ManagedDaemonStartError")<{
  readonly message: string;
}> {}

class SupervisorOwnerUnavailableError extends Data.TaggedError("SupervisorOwnerUnavailableError")<{
  readonly retry: boolean;
  readonly detail: string;
}> {}

const SUPERVISOR_STARTUP_TIMEOUT = "30 seconds" as const;

const awaitOwnerReady = (acquisition: ControlAttached) =>
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
        Schedule.upTo({ duration: SUPERVISOR_STARTUP_TIMEOUT }),
      ),
      while: (error) => error._tag === "SupervisorOwnerUnavailableError" && error.retry,
    }),
    Effect.catchTag("SupervisorOwnerUnavailableError", (error) =>
      Effect.fail(new SupervisorStartError({ message: error.detail })),
    ),
    Effect.asVoid,
  );

/** Minimal Stack implementation used only by explicit supervisor test mode. */
export const supervisorTestStackLayer = (config: ResolvedDaemonConfig): Layer.Layer<Stack> => {
  const info = {
    url: `http://127.0.0.1:${config.apiPort}`,
    dbUrl: `postgresql://postgres:postgres@127.0.0.1:${config.dbPort}/postgres`,
    publishableKey: config.publishableKey,
    secretKey: config.secretKey,
    anonJwt: config.anonJwt,
    serviceRoleJwt: config.serviceRoleJwt,
    serviceEndpoints: {},
  };
  const stack: Stack["Service"] = {
    getInfo: () => Effect.succeed(info),
    start: () => Effect.void,
    stop: () => Effect.void,
    dispose: () => Effect.void,
    startService: () => Effect.void,
    stopService: () => Effect.void,
    restartService: () => Effect.void,
    reloadFunctions: () => Effect.void,
    reloadEdgeRuntime: () => Effect.void,
    getState: () => Effect.die("test stack has no external service state"),
    getAllStates: () => Effect.succeed([]),
    stateChanges: () => Effect.succeed(Stream.empty),
    allStateChanges: () => Stream.empty,
    waitReady: () => Effect.void,
    waitAllReady: () => Effect.void,
    subscribeLogs: () => Stream.empty,
    subscribeAllLogs: () => Stream.empty,
    logHistory: () => Effect.succeed([]),
    logHistoryAll: () => Effect.succeed([]),
  };
  return Layer.succeed(Stack, stack);
};

export interface SupervisorPlatform {
  readonly platformFactory: PlatformFactory;
  /** Explicit external-service substitution used only when testMode is set. */
  readonly testRuntime?: (input: {
    readonly config: ResolvedDaemonConfig;
    readonly lease: PortLease;
    readonly mode: SupervisorTestMode;
  }) => Effect.Effect<Layer.Layer<Stack>, unknown, Scope.Scope>;
  readonly managerLayer?: (
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
  readonly managed: boolean;
  readonly stackLayer?: Layer.Layer<Stack>;
}): Effect.Effect<
  { readonly daemon: DaemonServer["Service"]; readonly state?: StackState },
  unknown,
  import("effect").FileSystem.FileSystem | import("effect").Path.Path
> =>
  Effect.gen(function* () {
    const appLayer =
      input.stackLayer === undefined
        ? input.managed
          ? foregroundLayer(input.config, input.platform.platformFactory, input.lease)
          : foregroundDaemonLayer(input.config, input.platform.platformFactory, input.lease)
        : input.managed
          ? input.stackLayer
          : Layer.mergeAll(
              input.stackLayer,
              StateManager.make(
                singleStackStateManagerPaths(
                  input.config.stackRoot,
                  input.config.runtimeRoot,
                  input.config.name,
                ),
              ),
            );
    const appServices = yield* Layer.buildWithScope(appLayer, input.scope);
    const localStack = Context.get(appServices, Stack);
    const stateManager = Context.getOption(appServices, StateManager);
    const daemonLayer = DaemonServer.layerWithShutdown(
      Effect.gen(function* () {
        yield* localStack.stop();
      }),
      input.ownership.ownerStatus,
      { includeOwnerRoute: false },
    ).pipe(
      Layer.provide(Layer.succeed(Stack, localStack)),
      Layer.provide(Layer.succeed(HttpServer.HttpServer, input.ownership.server)),
    );
    const daemonServices = yield* Layer.buildWithScope(daemonLayer, input.scope);
    const daemon = Context.get(daemonServices, DaemonServer);
    let state: StackState | undefined;
    if (Option.isSome(stateManager)) {
      const info = yield* localStack.getInfo();
      state = {
        pid: process.pid,
        name: input.config.name,
        projectDir: input.config.projectDir,
        apiPort: input.config.apiPort,
        dbPort: input.config.dbPort,
        ports: input.config.ports,
        socketPath: input.ownership.endpoint.path,
        startedAt: new Date().toISOString(),
        url: info.url,
        dbUrl: info.dbUrl,
        publishableKey: info.publishableKey,
        secretKey: info.secretKey,
        anonJwt: info.anonJwt,
        serviceRoleJwt: info.serviceRoleJwt,
        serviceEndpoints: info.serviceEndpoints,
        services: {},
      };
      yield* stateManager.value.claim(state);
    }
    return { daemon, state };
  });

const installTestRuntime = (
  platform: SupervisorPlatform,
  mode: SupervisorTestMode | undefined,
  config: ResolvedDaemonConfig,
  lease: PortLease,
): Effect.Effect<Layer.Layer<Stack> | undefined, unknown, Scope.Scope> =>
  Effect.suspend(() => {
    const testRuntime = platform.testRuntime;
    if (mode === undefined || testRuntime === undefined) return Effect.succeed(undefined);
    return Effect.gen(function* () {
      return yield* testRuntime({ config, lease, mode });
    });
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
    if (platform.managerLayer === undefined) {
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Managed supervisor layer is unavailable" }),
      );
    }
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
    const stackId = input.stackId ?? deriveStackId(discovery.identity, input.stackName);
    const acquisition = yield* acquireControl({ stackId });
    if (acquisition._tag === "Attached") {
      yield* awaitOwnerReady(acquisition);
      yield* sendMessage({ type: "started", endpoint: acquisition.endpoint, attached: true });
      process.disconnect?.();
      return;
    }
    const ownership = acquisition;
    owner = ownership;
    const existing = yield* manager.inspectStack(stackId);
    if (
      existing !== undefined &&
      (existing.lifecycle === "starting" ||
        existing.lifecycle === "running" ||
        existing.lifecycle === "failed" ||
        existing.lifecycle === "deleting")
    ) {
      yield* Effect.sync(() => {
        dockerForceRemove(
          SERVICE_NAMES.map((service) => dockerContainerName(service, `id-${stackId}`)),
        );
      });
    }
    if (input.operation === "delete") {
      if (existing !== undefined && existing.lifecycle !== "deleting") {
        yield* manager.recordLifecycle(ownership, { stackId, lifecycle: "deleting" });
      }
      if (input.testMode === "hold-delete") {
        yield* Effect.never;
      }
      yield* manager.deleteStack(stackId, ownership);
      yield* sendMessage({ type: "started", endpoint: ownership.endpoint, attached: false });
      process.disconnect?.();
      return;
    }
    const portDocument = toPortDocument(input.portIntents, input.effectiveConfig ?? {});
    const started: ManagedStackStartResult = yield* manager.resolveStack({
      operation: "start",
      workspacePath: input.workspacePath,
      stackName: input.stackName,
      portDocument,
      ownership,
      lifecycle: "starting",
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
    const testStackLayer = yield* installTestRuntime(
      platform,
      input.testMode,
      config,
      leaseFacade(started.lease),
    );
    if (input.testMode === "fail-after-bind" && testStackLayer !== undefined) {
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Supervisor test runtime failed after binding" }),
      );
    }
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
      managed: true,
      stackLayer: testStackLayer,
    });
    yield* manager.recordLifecycle(ownership, {
      stackId: started.stack.id,
      lifecycle: "running",
      runtime: {
        pid: process.pid,
        controlEndpoint: ownership.endpoint.path,
        protocolVersion: 1,
      },
    });
    yield* sendMessage({
      type: "started",
      endpoint: ownership.endpoint,
      attached: false,
    });
    process.disconnect?.();
    yield* Effect.raceFirst(waitForSignal(), built.daemon.awaitShutdown);
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

const runEphemeral = (
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
> =>
  Effect.gen(function* () {
    const configInput = toDaemonConfig(input.config);
    if (configInput === undefined) {
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Supervisor config is missing cwd" }),
      );
    }
    const ownershipId = input.ownershipId ?? input.stackId ?? randomUUID().replaceAll("-", "");
    const acquisition = yield* acquireControl({ stackId: ownershipId });
    if (acquisition._tag === "Attached") {
      yield* awaitOwnerReady(acquisition);
      yield* sendMessage({ type: "started", endpoint: acquisition.endpoint, attached: true });
      process.disconnect?.();
      return;
    }
    const ownership = acquisition;
    let lease: PortLease | undefined;
    const config = yield* Effect.tryPromise({
      try: () =>
        resolveDaemonConfig(configInput, {
          portAllocator: (requests, options) =>
            reservePortSet(requests, options).pipe(
              Effect.tap((nextLease) => Effect.sync(() => void (lease = nextLease))),
              Effect.map((nextLease) => nextLease.ports),
            ),
        }),
      catch: (cause) => cause,
    });
    if (lease === undefined) {
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Supervisor allocation did not return a lease" }),
      );
    }
    const allocatedLease = lease;
    yield* Effect.addFinalizer(() => allocatedLease.releaseAll);
    const stateServices = yield* Layer.buildWithScope(
      StateManager.make(
        singleStackStateManagerPaths(config.stackRoot, config.runtimeRoot, config.name),
      ),
      scope,
    );
    const stateManager = Context.get(stateServices, StateManager);
    const staleState = yield* stateManager.read(config.name).pipe(
      Effect.catchTag("StateNotFoundError", () => Effect.succeed(undefined)),
      Effect.catchTag("InvalidStackStateError", () =>
        stateManager.remove(config.name).pipe(Effect.as(undefined)),
      ),
    );
    if (staleState !== undefined) {
      const alive = yield* stateManager.isAlive(staleState);
      if (alive) {
        return yield* Effect.fail(
          new SupervisorStartError({ message: `Ordinary stack ${config.name} is already running` }),
        );
      }
      yield* stateManager.remove(config.name);
    }
    const testStackLayer = yield* installTestRuntime(
      platform,
      input.testMode,
      config,
      allocatedLease,
    );
    if (input.testMode === "fail-after-bind" && testStackLayer !== undefined) {
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Supervisor test runtime failed after binding" }),
      );
    }
    const built = yield* startDaemon({
      config,
      lease: allocatedLease,
      ownership,
      platform,
      scope,
      managed: false,
      stackLayer: testStackLayer,
    });
    yield* sendMessage({ type: "started", endpoint: ownership.endpoint });
    process.disconnect?.();
    yield* Effect.raceFirst(waitForSignal(), built.daemon.awaitShutdown);
    if (built.state !== undefined) yield* stateManager.remove(config.name);
  });

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
      yield* Effect.matchCauseEffect(
        input.mode === "managed"
          ? runManaged(input, platform, scope)
          : runEphemeral(input, platform, scope),
        {
          onFailure: (cause) =>
            sendMessage({ type: "error", message: causeMessage(cause) }).pipe(
              Effect.andThen(Effect.failCause(cause)),
            ),
          onSuccess: Effect.succeed,
        },
      );
    }),
  );

const forkSupervisor = (entryPoint: string): Effect.Effect<ChildProcess, SupervisorStartError> =>
  Effect.try({
    try: () =>
      fork(entryPoint, [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: true,
        env: { ...process.env, SUPABASE_STACK_RUN_SUPERVISOR: "1" },
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

/** Parent-side shared launcher used by managed and ordinary layers. */
export const supervisorLayer = (
  input: SupervisorStartMessage,
  entryPoint: string,
): Effect.Effect<Layer.Layer<import("./Stack.ts").Stack>, SupervisorStartError, UnixHttpClient> =>
  Effect.gen(function* () {
    const client = yield* UnixHttpClient;
    const child = yield* forkSupervisor(entryPoint);
    let detached = false;
    return yield* Effect.gen(function* () {
      const responseFiber = yield* waitForStarted(child).pipe(
        Effect.timeout(SUPERVISOR_STARTUP_TIMEOUT),
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
        Layer.provide(Layer.succeed(UnixHttpClient, client)),
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
  options: { readonly testMode?: SupervisorTestMode } = {},
): Effect.Effect<Layer.Layer<Stack>, SupervisorStartError, UnixHttpClient> =>
  supervisorLayer(
    {
      type: "start",
      mode: "managed",
      workspacePath: input.workspacePath,
      stackName: input.stackName,
      stateRoot: input.stateRoot,
      config: {
        ...input.config,
        cwd: typeof input.config.cwd === "string" ? input.config.cwd : input.workspacePath,
      },
      effectiveConfig: input.effectiveConfig,
      portIntents: {
        activeFields: [...PORT_FIELDS],
        document: input.effectiveConfig,
        ...(input.valueOrigins === undefined ? {} : { valueOrigins: input.valueOrigins }),
      },
      ...(input.stackId === undefined ? {} : { stackId: input.stackId }),
      ...(input.socketPath === undefined ? {} : { socketPath: input.socketPath }),
      ...(options.testMode === undefined ? {} : { testMode: options.testMode }),
    },
    entryPoint,
  );
