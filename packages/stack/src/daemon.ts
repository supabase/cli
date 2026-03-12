import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpServer } from "effect/unstable/http";
import type { PlatformFactory } from "./createStack.ts";
import { DaemonServer } from "./DaemonServer.ts";
import { foregroundDaemonLayer } from "./layers.ts";
import { Stack } from "./Stack.ts";
import type { ResolvedStackConfig } from "./StackBuilder.ts";
import { StateManager, type StackState, type StateManagerService } from "./StateManager.ts";

/** Factory for creating the daemon's Unix socket HTTP server (platform-specific). */
export type DaemonHttpServerFactory = (socketPath: string) => Layer.Layer<HttpServer.HttpServer>;

// ---------------------------------------------------------------------------
// IPC message types
// ---------------------------------------------------------------------------

export interface DaemonStartMessage {
  readonly type: "start";
  readonly config: ResolvedStackConfig;
  readonly name: string;
  readonly projectDir: string;
  readonly socketPath: string;
}

export interface DaemonStartedMessage {
  readonly type: "started";
  readonly state: StackState;
}

export interface DaemonErrorMessage {
  readonly type: "error";
  readonly message: string;
}

export type DaemonMessage = DaemonStartedMessage | DaemonErrorMessage;

// ---------------------------------------------------------------------------
// Daemon entry point
// ---------------------------------------------------------------------------

export async function runDaemon(
  platformFactory: PlatformFactory,
  daemonServerFactory: DaemonHttpServerFactory,
): Promise<void> {
  const msg = await waitForMessage<DaemonStartMessage>();
  const { config, name, projectDir, socketPath } = msg;

  let appRuntime: ManagedRuntime.ManagedRuntime<Stack | StateManager, never> | undefined;
  let daemonRuntime: ManagedRuntime.ManagedRuntime<DaemonServer, never> | undefined;
  let stateManager: StateManagerService | undefined;
  let daemonState: StackState | undefined;

  try {
    // Build the app layer (Stack + ApiProxy)
    const appLayer = foregroundDaemonLayer({ ...config, name, projectDir }, platformFactory);

    appRuntime = ManagedRuntime.make(appLayer);

    // Build the stack (services are started later via POST /start)
    const localStack = await appRuntime.runPromise(Stack.asEffect());
    const info = await appRuntime.runPromise(localStack.getInfo());
    stateManager = await appRuntime.runPromise(StateManager.asEffect());

    // Build daemon management server on Unix socket
    const daemonLayer = DaemonServer.layer.pipe(
      Layer.provide(Layer.succeed(Stack, localStack)),
      Layer.provide(daemonServerFactory(socketPath)),
    ) as unknown as Layer.Layer<DaemonServer, never, never>;

    daemonRuntime = ManagedRuntime.make(daemonLayer);
    await daemonRuntime.runPromise(DaemonServer.asEffect());

    // Build state and signal success to parent.
    // The parent (CLI) is responsible for writing the state file via StateManager.
    const state: StackState = {
      pid: process.pid,
      name,
      projectDir,
      apiPort: config.apiPort,
      dbPort: config.dbPort,
      ports: config.ports,
      socketPath,
      startedAt: new Date().toISOString(),
      url: info.url,
      dbUrl: info.dbUrl,
      publishableKey: info.publishableKey,
      secretKey: info.secretKey,
      anonJwt: info.anonJwt,
      serviceRoleJwt: info.serviceRoleJwt,
      dockerContainerNames: Array.from(info.dockerContainerNames),
      serviceEndpoints: info.serviceEndpoints,
    };
    daemonState = state;
    await Effect.runPromise(stateManager.write(state));
    await Effect.runPromise(stateManager.writePorts(name, config.ports));

    const response: DaemonStartedMessage = { type: "started", state };
    process.send!(response);
    process.disconnect?.();

    const daemon = await daemonRuntime.runPromise(DaemonServer.asEffect());
    await Promise.race([daemonRuntime.runPromise(daemon.awaitShutdown), waitForSignal()]);
    await shutdownDaemon({ appRuntime, daemonRuntime, stateManager, daemonState });
    process.exit(0);
  } catch (err) {
    const errorMsg: DaemonErrorMessage = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    process.send?.(errorMsg);
    await shutdownDaemon({ appRuntime, daemonRuntime, stateManager, daemonState });
    process.exit(1);
  }
}

function waitForMessage<T>(): Promise<T> {
  return new Promise((resolve) => {
    process.once("message", (msg) => resolve(msg as T));
  });
}

function waitForSignal(): Promise<"SIGINT" | "SIGTERM"> {
  return new Promise((resolve) => {
    const onSigterm = () => {
      cleanup();
      resolve("SIGTERM");
    };
    const onSigint = () => {
      cleanup();
      resolve("SIGINT");
    };
    const cleanup = () => {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    };

    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
  });
}

async function shutdownDaemon(opts: {
  readonly appRuntime?: ManagedRuntime.ManagedRuntime<Stack, never>;
  readonly daemonRuntime?: ManagedRuntime.ManagedRuntime<DaemonServer, never>;
  readonly stateManager?: StateManagerService;
  readonly daemonState?: StackState;
}): Promise<void> {
  await opts.daemonRuntime?.dispose().catch(() => {});
  await opts.appRuntime?.dispose().catch(() => {});

  if (opts.stateManager != null && opts.daemonState != null) {
    await Effect.runPromise(opts.stateManager.remove(opts.daemonState.name)).catch(() => {});
  }
}
