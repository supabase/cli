import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Stream, Duration } from "effect";
import { createServer, type Server } from "node:net";
import {
  runSupervisor,
  SupervisorStartError,
  type SupervisorPlatform,
} from "../../src/supervisor.ts";
import { Stack } from "../../src/Stack.ts";
import { gitConfigStoreLayer } from "../../src/managed/git.ts";
import { managedStackManagerLayer } from "../../src/managed/manager.ts";
import { controlTransportLayer, platformFactory } from "../../src/platform-node.ts";
import { PORT_FIELDS } from "../../src/PortCatalog.ts";
import type { PortLease } from "../../src/PortAllocator.ts";
import type { ResolvedDaemonConfig } from "../../src/StackConfig.ts";

type TestMode = "bind-all" | "fail-after-bind" | "hold-reservations" | "hold-start" | "hold-stop";

const testMode = (): TestMode => {
  const value = process.env["SUPABASE_STACK_TEST_RUNTIME_MODE"];
  if (value === "fail-after-bind") return value;
  if (value === "hold-reservations") return value;
  if (value === "hold-start") return value;
  if (value === "hold-stop") return value;
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

const testStackLayer = (config: ResolvedDaemonConfig, mode: TestMode): Layer.Layer<Stack> => {
  const info = {
    url: `http://127.0.0.1:${config.apiPort}`,
    dbUrl: `postgresql://postgres:postgres@127.0.0.1:${config.dbPort}/postgres`,
    publishableKey: config.publishableKey,
    secretKey: config.secretKey,
    anonJwt: config.anonJwt,
    serviceRoleJwt: config.serviceRoleJwt,
    serviceEndpoints: {},
  };
  return Layer.succeed(Stack, {
    getInfo: () => Effect.succeed(info),
    start: () => Effect.void,
    stop: () => (mode === "hold-stop" ? Effect.never : Effect.void),
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
  });
};

const testRuntime = ({
  config,
  lease,
}: {
  readonly config: ResolvedDaemonConfig;
  readonly lease: PortLease;
}): Effect.Effect<Layer.Layer<Stack>, unknown, import("effect").Scope.Scope> => {
  const mode = testMode();
  return Effect.gen(function* () {
    if (mode === "hold-start") yield* Effect.never;
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
      return yield* Effect.fail(
        new SupervisorStartError({ message: "Supervisor test runtime failed after binding" }),
      );
    }
    return testStackLayer(config, mode);
  });
};

const sendTestStage = (): Effect.Effect<void, SupervisorStartError> =>
  Effect.callback((resume) => {
    if (process.send === undefined || !process.connected) {
      resume(Effect.void);
      return Effect.void;
    }
    try {
      process.send({ type: "test-stage", stage: "attached-before-ready" }, (error) =>
        resume(
          error === null
            ? Effect.void
            : Effect.fail(new SupervisorStartError({ message: error.message })),
        ),
      );
    } catch (cause) {
      resume(
        Effect.fail(
          new SupervisorStartError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      );
    }
    return Effect.void;
  });

const resolutionTimeout = (): Duration.Input => {
  const milliseconds = Number(process.env["SUPABASE_STACK_TEST_STARTUP_TIMEOUT_MS"]);
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? `${milliseconds} millis`
    : "30 seconds";
};

const managerLayer = (stateRoot: string) =>
  managedStackManagerLayer({ stateRoot }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        gitConfigStoreLayer,
        controlTransportLayer,
      ),
    ),
  );

export const runTestSupervisor = (): void => {
  const mode = testMode();
  const platform: SupervisorPlatform = {
    platformFactory,
    managerLayer,
    runtimeLayer: testRuntime,
    ...(mode === "hold-start" ? { onAttachedBeforeReady: sendTestStage } : {}),
    resolutionTimeout: resolutionTimeout(),
  };
  void Effect.runPromise(
    runSupervisor(platform).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    ),
  );
};

if (import.meta.main) runTestSupervisor();
