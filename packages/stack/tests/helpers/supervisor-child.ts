// oxlint-disable effecttsgo/node-builtin-import, effecttsgo/process-env, effecttsgo/process-env-in-effect -- The child fixture is a native subprocess boundary that composes platform layers and forwards its environment to the supervisor.
import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { Deferred, Effect, Layer, Stream, Duration } from "effect";
import { createServer, type Server } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  runSupervisor,
  SupervisorStartError,
  type SupervisorPlatform,
} from "../../src/supervisor.ts";
import { LocalStackLifecycle } from "../../src/LocalStack.ts";
import { Stack } from "../../src/Stack.ts";
import { validateResolvedConfig } from "../../src/StackBuilder.ts";
import { StackBuildError, StackReadinessError } from "../../src/errors.ts";
import { ControlTransport } from "../../src/managed/control.ts";
import { gitConfigStoreLayer } from "../../src/managed/git.ts";
import { ManagedStackManager, managedStackManagerLayer } from "../../src/managed/manager.ts";
import {
  controlTransportLayer as nodeControlTransportLayer,
  platformFactory as nodePlatformFactory,
} from "../../src/platform-node.ts";
import { PORT_FIELDS } from "../../src/PortCatalog.ts";
import type { PortLease } from "../../src/PortAllocator.ts";
import type { ResolvedDaemonConfig } from "../../src/StackConfig.ts";
import { watchDirectoryWithRetry } from "./file-watch.ts";

type TestMode =
  | "bind-all"
  | "fail-after-bind"
  | "hold-reservations"
  | "hold-start"
  | "hold-stop"
  | "readiness-failure";
const FILE_WAIT_TIMEOUT = "30 seconds";

const waitForFile = (path: string): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (existsSync(path)) {
      resume(Effect.void);
      return Effect.void;
    }
    let settled = false;
    let stopWatching: (() => void) | undefined;
    const cleanup = () => {
      stopWatching?.();
      stopWatching = undefined;
    };
    const settle = (result: Effect.Effect<void>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(result);
    };
    const check = () => {
      if (existsSync(path)) settle(Effect.void);
    };
    stopWatching = watchDirectoryWithRetry(dirname(path), check, (cause) =>
      settle(Effect.die(cause)),
    );
    check();
    return Effect.sync(cleanup);
  }).pipe(
    Effect.timeout(FILE_WAIT_TIMEOUT),
    Effect.catchTag("TimeoutError", () =>
      Effect.die(new Error(`timed out waiting for file ${path} after ${FILE_WAIT_TIMEOUT}`)),
    ),
  );

const testMode = (): TestMode => {
  const value = process.env["SUPABASE_STACK_TEST_RUNTIME_MODE"];
  if (value === "fail-after-bind") return value;
  if (value === "hold-reservations") return value;
  if (value === "hold-start") return value;
  if (value === "hold-stop") return value;
  if (value === "readiness-failure") return value;
  return "bind-all";
};

const bindTestPort = (port: number): Effect.Effect<Server> =>
  Effect.callback((resume) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (cause: Error) => resume(Effect.die(cause));
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => server.close());
  });

const closeTestPorts = (servers: ReadonlyArray<Server>): Effect.Effect<void> =>
  Effect.forEach(
    servers,
    (server) =>
      Effect.callback<void>((resume) => {
        if (!server.listening) {
          resume(Effect.void);
          return Effect.void;
        }
        server.close(() => resume(Effect.void));
        return Effect.void;
      }),
    { discard: true },
  );

const testStackLayer = (
  config: ResolvedDaemonConfig,
  mode: TestMode,
  disposed: Deferred.Deferred<void>,
): Layer.Layer<Stack> => {
  const info = {
    url: `http://127.0.0.1:${config.apiPort}`,
    dbUrl: `postgresql://postgres:postgres@127.0.0.1:${config.dbPort}/postgres`,
    publishableKey: config.publishableKey,
    secretKey: config.secretKey,
    anonJwt: config.anonJwt,
    serviceRoleJwt: config.serviceRoleJwt,
    serviceEndpoints: {},
  };
  const waitForStopRelease = (): Effect.Effect<void> => {
    const path = process.env["SUPABASE_STACK_TEST_STOP_RELEASE_FILE"];
    if (path === undefined) return Effect.never;
    return waitForFile(path);
  };
  return Layer.succeed(Stack, {
    getInfo: () => Effect.succeed(info),
    start: () => Effect.void,
    stop: () =>
      mode === "hold-stop"
        ? Effect.gen(function* () {
            const stageFile = process.env["SUPABASE_STACK_TEST_STOP_BEGAN_FILE"];
            if (stageFile !== undefined) {
              yield* Effect.sync(() => writeFileSync(stageFile, "began"));
            }
            yield* waitForStopRelease();
          })
        : Effect.void,
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
    waitAllReady: () =>
      mode === "readiness-failure"
        ? Deferred.succeed(disposed, undefined).pipe(
            Effect.andThen(
              Effect.fail(
                new StackReadinessError({
                  target: "stack",
                  timeoutMs: 75,
                  detail: "Timed out waiting for stack readiness after 75ms",
                }),
              ),
            ),
          )
        : Effect.void,
    subscribeLogs: () => Stream.empty,
    subscribeAllLogs: () => Stream.empty,
    logHistory: () => Effect.succeed([]),
    logHistoryAll: () => Effect.succeed([]),
  });
};

const testRuntime = ({
  config,
  lease,
}: {
  readonly config: ResolvedDaemonConfig;
  readonly lease: PortLease;
}): Effect.Effect<
  Layer.Layer<Stack | LocalStackLifecycle>,
  SupervisorStartError,
  import("effect").Scope.Scope
> => {
  const mode = testMode();
  return Effect.gen(function* () {
    const disposed = Deferred.makeUnsafe<void>();
    yield* validateResolvedConfig(config);
    if (mode === "hold-start") {
      const releaseFile = process.env["SUPABASE_STACK_TEST_START_RELEASE_FILE"];
      yield* releaseFile === undefined ? Effect.never : waitForFile(releaseFile);
    }
    const servers: Array<Server> = [];
    if (mode !== "hold-reservations") {
      for (const field of PORT_FIELDS) {
        const port = config.ports[field];
        if (port === undefined) continue;
        yield* lease.release([field]);
        servers.push(yield* bindTestPort(port));
      }
    }
    yield* Effect.addFinalizer(() => closeTestPorts(servers));
    if (mode === "fail-after-bind") {
      // Returning the failed yield exits this fixture before the success layer is constructed.
      // oxlint-disable-next-line effecttsgo/unnecessary-fail-yieldable-error
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Supervisor test runtime failed after binding" }),
      );
    }
    return Layer.mergeAll(
      testStackLayer(config, mode, disposed),
      Layer.succeed(LocalStackLifecycle, {
        awaitDisposed: Deferred.await(disposed),
        isDisposed: Effect.succeed(mode === "readiness-failure"),
      }),
    );
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof SupervisorStartError
        ? cause
        : new SupervisorStartError({
            message: cause instanceof StackBuildError ? cause.detail : String(cause),
          }),
    ),
  );
};

const observeAttachedBeforeReady = (value: unknown): Effect.Effect<void> => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ready" in value) ||
    value.ready !== false ||
    !("state" in value) ||
    (value.state !== "starting" && value.state !== "stopping")
  ) {
    return Effect.void;
  }
  const readyFile = process.env["SUPABASE_STACK_TEST_ATTACHED_READY_FILE"];
  const releaseFile = process.env["SUPABASE_STACK_TEST_ATTACHED_RELEASE_FILE"];
  if (readyFile === undefined || existsSync(readyFile)) return Effect.void;
  return Effect.sync(() => writeFileSync(readyFile, "ready")).pipe(
    Effect.andThen(releaseFile === undefined ? Effect.void : waitForFile(releaseFile)),
  );
};

const resolutionTimeout = (): Duration.Input => {
  const milliseconds = Number(process.env["SUPABASE_STACK_TEST_STARTUP_TIMEOUT_MS"]);
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? `${milliseconds} millis`
    : "30 seconds";
};

const testPlatform = (): "node" | "bun" =>
  process.env["SUPABASE_STACK_TEST_PLATFORM"] === "bun" ? "bun" : "node";

const decorateManagerLayer = <E, R>(base: Layer.Layer<ManagedStackManager, E, R>) => {
  const readyFile = process.env["SUPABASE_STACK_TEST_ENSURE_READY_FILE"];
  const releaseFile = process.env["SUPABASE_STACK_TEST_ENSURE_RELEASE_FILE"];
  return Layer.effect(
    ManagedStackManager,
    ManagedStackManager.pipe(
      Effect.map((manager) => ({
        ...manager,
        startStack: (input: Parameters<typeof manager.startStack>[0]) =>
          manager.startStack(input).pipe(
            Effect.tap(() => {
              const markerFile = process.env["SUPABASE_STACK_TEST_MANAGED_STARTED_FILE"];
              const releaseFile = process.env["SUPABASE_STACK_TEST_MANAGED_STARTED_RELEASE_FILE"];
              return Effect.sync(() => {
                if (markerFile !== undefined) writeFileSync(markerFile, "started");
              }).pipe(
                Effect.andThen(releaseFile === undefined ? Effect.void : waitForFile(releaseFile)),
                Effect.orDie,
              );
            }),
          ),
        ...(readyFile === undefined || releaseFile === undefined
          ? {}
          : {
              ensureWorkspace: (workspacePath: string) =>
                Effect.sync(() => writeFileSync(readyFile, "ready")).pipe(
                  Effect.andThen(waitForFile(releaseFile)),
                  Effect.andThen(manager.ensureWorkspace(workspacePath)),
                ),
            }),
      })),
    ),
  ).pipe(Layer.provide(base));
};

const nodeManagerLayer = (stateRoot: string) =>
  decorateManagerLayer(
    managedStackManagerLayer({ stateRoot, preferCatalogDefaults: false }).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeFileSystem.layer,
          NodePath.layer,
          gitConfigStoreLayer,
          nodeControlTransportLayer,
        ),
      ),
    ),
  );

const testControlTransportLayer = <E, R>(base: Layer.Layer<ControlTransport, E, R>) =>
  Layer.effect(
    ControlTransport,
    Effect.gen(function* () {
      const transport = yield* ControlTransport;
      return {
        ...transport,
        read: (endpoint: Parameters<typeof transport.read>[0]) =>
          transport.read(endpoint).pipe(Effect.tap(observeAttachedBeforeReady)),
      };
    }),
  ).pipe(Layer.provide(base));

export const runTestSupervisor = (): void => {
  const platformKind = testPlatform();
  if (platformKind === "node") {
    const supervisorPlatform: SupervisorPlatform = {
      platformFactory: nodePlatformFactory,
      managerLayer: nodeManagerLayer,
      runtimeLayer: testRuntime,
      resolutionTimeout: resolutionTimeout(),
    };
    // runSupervisor's runtime layers are provided in dependency order: the decorated manager
    // and transport layers must be built before the platform services are attached.
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
    const program = runSupervisor(supervisorPlatform).pipe(
      // oxlint-disable-next-line effecttsgo/multiple-effect-provide
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(testControlTransportLayer(nodeControlTransportLayer)),
      Effect.provide(NodeServices.layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
    );
    // The child process is intentionally launched at this native Promise boundary.
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
    void Effect.runPromise(program);
    return;
  }
  void Promise.all([
    import("@effect/platform-bun/BunFileSystem"),
    import("@effect/platform-bun/BunServices"),
    import("../../src/platform-bun.ts"),
  ]).then(([bunFileSystem, bunServices, bunPlatform]) => {
    const managerLayer = (stateRoot: string) =>
      decorateManagerLayer(
        managedStackManagerLayer({ stateRoot, preferCatalogDefaults: false }).pipe(
          Layer.provide(
            Layer.mergeAll(
              bunFileSystem.layer,
              gitConfigStoreLayer,
              bunPlatform.controlTransportLayer,
            ),
          ),
        ),
      );
    const supervisorPlatform: SupervisorPlatform = {
      platformFactory: bunPlatform.platformFactory,
      managerLayer,
      runtimeLayer: testRuntime,
      resolutionTimeout: resolutionTimeout(),
    };
    // runSupervisor's runtime layers are provided in dependency order: the decorated manager
    // and transport layers must be built before the platform services are attached.
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
    const program = runSupervisor(supervisorPlatform).pipe(
      // oxlint-disable-next-line effecttsgo/multiple-effect-provide
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(testControlTransportLayer(bunPlatform.controlTransportLayer)),
      Effect.provide(bunServices.layer),
      Effect.provide(bunFileSystem.layer),
    );
    // The child process is intentionally launched at this native Promise boundary.
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
    return Effect.runPromise(program);
  });
};

if (import.meta.main) runTestSupervisor();
