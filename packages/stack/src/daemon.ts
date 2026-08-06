import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpServer } from "effect/unstable/http";
import type { PlatformFactory } from "./createStack.ts";
import { DaemonServer } from "./DaemonServer.ts";
import { PORT_FIELDS, reservePorts, type PortLease } from "./PortAllocator.ts";
import { allocatedPortFieldsForConfig } from "./ServicePorts.ts";
import { runningServiceVersionsForConfig } from "./StackMetadata.ts";
import { foregroundDaemonLayer } from "./layers.ts";
import { Stack } from "./Stack.ts";
import { resolveDaemonConfig, type DaemonConfigInput } from "./StackConfigResolver.ts";
import { StateManager, type StackState } from "./StateManager.ts";

/** Factory for creating the daemon's Unix socket HTTP server (platform-specific). */
export type DaemonHttpServerFactory = (socketPath: string) => Layer.Layer<HttpServer.HttpServer>;

// ---------------------------------------------------------------------------
// IPC message types
// ---------------------------------------------------------------------------

export interface DaemonStartMessage {
  readonly type: "start";
  readonly config: DaemonConfigInput;
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
  const { socketPath } = msg;

  let appRuntime: ManagedRuntime.ManagedRuntime<Stack | StateManager, never> | undefined;
  let daemonRuntime: ManagedRuntime.ManagedRuntime<DaemonServer, never> | undefined;
  let portLease: PortLease | undefined;

  try {
    const config = await resolveDaemonConfig(msg.config, {
      portAllocator: (input, options) =>
        reservePorts(input, options).pipe(
          Effect.tap((lease) =>
            Effect.sync(() => {
              portLease = lease;
            }),
          ),
          Effect.map((lease) => lease.ports),
        ),
    });
    if (portLease === undefined) {
      throw new Error("Daemon port allocation completed without a port lease");
    }
    const activeFields = new Set(allocatedPortFieldsForConfig(config));
    await Effect.runPromise(
      portLease.release(PORT_FIELDS.filter((field) => !activeFields.has(field))),
    );

    // Build the app layer (Stack + ApiProxy)
    const appLayer = foregroundDaemonLayer(config, platformFactory, portLease);

    appRuntime = ManagedRuntime.make(appLayer);

    // Build the stack (services are started later via POST /start)
    const localStack = await appRuntime.runPromise(Stack);
    const info = await appRuntime.runPromise(localStack.getInfo());
    const localStateManager = await appRuntime.runPromise(StateManager);

    // Build daemon management server on Unix socket
    const daemonLayer = DaemonServer.layer.pipe(
      Layer.provide(Layer.succeed(Stack, localStack)),
      Layer.provide(daemonServerFactory(socketPath)),
    );

    daemonRuntime = ManagedRuntime.make(daemonLayer);
    await daemonRuntime.runPromise(DaemonServer);

    // Claim live state before acknowledging startup to the parent.
    const state: StackState = {
      pid: process.pid,
      name: config.name,
      projectDir: config.projectDir,
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
      serviceEndpoints: info.serviceEndpoints,
      services: runningServiceVersionsForConfig(config),
    };
    await Effect.runPromise(localStateManager.claim(state));

    const response: DaemonStartedMessage = { type: "started", state };
    process.send!(response);
    process.disconnect?.();

    const daemon = await daemonRuntime.runPromise(DaemonServer);
    await Promise.race([daemonRuntime.runPromise(daemon.awaitShutdown), waitForSignal()]);
    await shutdownDaemon({ appRuntime, daemonRuntime });
    process.exit(0);
  } catch (err) {
    const errorMsg: DaemonErrorMessage = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    process.send?.(errorMsg);
    await shutdownDaemon({ appRuntime, daemonRuntime });
    if (portLease !== undefined) {
      await Effect.runPromise(portLease.releaseAll);
    }
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
}): Promise<void> {
  await opts.daemonRuntime?.dispose().catch(() => {});
  await opts.appRuntime?.dispose().catch(() => {});
}
