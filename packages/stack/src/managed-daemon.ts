import { fork, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Data, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { ApiProxy } from "./ApiProxy.ts";
import { DaemonServer } from "./DaemonServer.ts";
import type { DaemonHttpServerFactory } from "./daemon.ts";
import { foregroundDaemonLayer } from "./layers.ts";
import type { PlatformFactory } from "./createStack.ts";
import { LocalStackLifecycle } from "./LocalStack.ts";
import { resolveConfig } from "./StackConfigResolver.ts";
import { portFieldsForConfigInput } from "./ServicePorts.ts";
import type { ResolvedDaemonConfig, StackConfig } from "./StackConfig.ts";
import { Stack } from "./Stack.ts";
import { StateManager } from "./StateManager.ts";
import type { PortLease } from "./PortAllocator.ts";
import type {
  ManagedPortIntentDocument,
  ManagedRuntimeMetadata,
  ManagedStackRecord,
} from "./managed/model.ts";
import type { ManagedRuntimePortAllocation } from "./managed/service.ts";
import type { ManagedStackServiceHandle } from "./managed/create-service.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { UnixHttpClient } from "./UnixHttpClient.ts";
import { FileSystem, Path } from "effect";
import { terminateChildProcess } from "./terminateChild.ts";

type ManagedDaemonConfig = Omit<StackConfig, "functions">;

export interface ManagedDaemonStartInput {
  readonly workspacePath: string;
  readonly stackName: string;
  readonly stateRoot: string;
  readonly config: ManagedDaemonConfig;
  /** Effective pre-default document used for managed intent resolution. */
  readonly effectiveConfig: Readonly<Record<string, unknown>>;
  readonly valueOrigins?: ManagedPortIntentDocument["valueOrigins"];
  readonly socketPath: string;
}

type ManagedDaemonStartMessage = ManagedDaemonStartInput & { readonly type: "start" };

export class ManagedDaemonStartError extends Data.TaggedError("ManagedDaemonStartError")<{
  readonly message: string;
}> {}

interface ManagedDaemonRuntimeBootstrapInput {
  readonly stack: ManagedStackRecord;
  readonly config: ResolvedDaemonConfig;
  readonly allocation: ManagedRuntimePortAllocation;
  readonly socketPath: string;
}

/** Test-only runtime seam; the production entrypoints use the normal stack runtime. */
type ManagedDaemonRuntimeBootstrap = (
  input: ManagedDaemonRuntimeBootstrapInput,
) => Promise<ManagedRuntimeMetadata>;

type ManagedDaemonServiceFactory = (options: {
  readonly stateRoot: string;
  readonly ownerPid: number;
}) => Promise<ManagedStackServiceHandle>;

export interface ManagedDaemonDependencies {
  readonly createService: ManagedDaemonServiceFactory;
  readonly runtimeBootstrap?: ManagedDaemonRuntimeBootstrap;
}

interface ManagedDaemonChildRuntimes {
  readonly appRuntime?: ManagedRuntime.ManagedRuntime<
    Stack | StateManager | ApiProxy | LocalStackLifecycle,
    never
  >;
  readonly daemonRuntime?: ManagedRuntime.ManagedRuntime<DaemonServer, never>;
  readonly portLease?: PortLease;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isManagedDaemonStartMessage = (value: unknown): value is ManagedDaemonStartMessage => {
  if (!isRecord(value)) return false;
  return (
    value.type === "start" &&
    typeof value.workspacePath === "string" &&
    typeof value.stackName === "string" &&
    typeof value.stateRoot === "string" &&
    isRecord(value.config) &&
    isRecord(value.effectiveConfig) &&
    (value.valueOrigins === undefined || Array.isArray(value.valueOrigins)) &&
    typeof value.socketPath === "string"
  );
};

const waitForManagedMessage = (): Promise<ManagedDaemonStartMessage> =>
  new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      cleanup();
      if (isManagedDaemonStartMessage(message)) {
        resolve(message);
      } else {
        reject(new Error("Managed daemon received an invalid start message"));
      }
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("Managed daemon parent disconnected before startup"));
    };
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    process.once("message", onMessage);
    process.once("disconnect", onDisconnect);
  });

const shutdownManagedRuntime = async (runtimes: ManagedDaemonChildRuntimes): Promise<void> => {
  await runtimes.daemonRuntime?.dispose().catch(() => {});
  await runtimes.appRuntime?.dispose().catch(() => {});
  if (runtimes.portLease !== undefined) {
    await Effect.runPromise(runtimes.portLease.releaseAll).catch(() => {});
  }
};

const makeRuntimeMetadata = (socketPath: string): ManagedRuntimeMetadata => ({
  pid: process.pid,
  socketPath,
  processIds: {},
  containerIds: {},
});

const waitForSignal = (): Promise<"SIGINT" | "SIGTERM"> =>
  new Promise((resolve) => {
    const onSigint = () => {
      cleanup();
      resolve("SIGINT");
    };
    const onSigterm = () => {
      cleanup();
      resolve("SIGTERM");
    };
    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });

const sendManagedDaemonStarted = (socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (process.send === undefined || !process.connected) {
      resolve();
      return;
    }
    process.send({ type: "started", socketPath }, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });

/**
 * Child-side managed composition. Identity, intent resolution, SQLite claims,
 * and the socket lease all live in this process; the parent only receives the
 * post-publication acknowledgement.
 */
export async function runManagedDaemon(
  platformFactory: PlatformFactory,
  daemonServerFactory: DaemonHttpServerFactory,
  dependencies: ManagedDaemonDependencies,
): Promise<void> {
  const message = await waitForManagedMessage();
  const runtimes: {
    appRuntime?: ManagedRuntime.ManagedRuntime<
      Stack | StateManager | ApiProxy | LocalStackLifecycle,
      never
    >;
    daemonRuntime?: ManagedRuntime.ManagedRuntime<DaemonServer, never>;
    portLease?: PortLease;
  } = {};
  let service: ManagedStackServiceHandle | undefined;
  let initialized = false;
  let startupAcknowledged = false;

  try {
    service = await dependencies.createService({
      stateRoot: message.stateRoot,
      ownerPid: process.pid,
    });
    const portDocument: ManagedPortIntentDocument = {
      activeFields: portFieldsForConfigInput(message.config),
      document: message.effectiveConfig,
      ...(message.valueOrigins === undefined ? {} : { valueOrigins: message.valueOrigins }),
    };
    const started = await service.resolveStack({
      workspacePath: message.workspacePath,
      stackName: message.stackName,
      operation: "start",
      portDocument,
      initialize: async (stack, allocation) => {
        initialized = true;
        const resolved = await resolveConfig(
          {
            ...message.config,
            projectDir: message.config.projectDir ?? message.workspacePath,
            stackRoot: stack.paths.root,
            runtimeRoot: stack.paths.runtime,
            instanceId: stack.id,
          },
          {
            // The managed coordinator already owns these sockets. Returning
            // its concrete ports makes resolution a pure projection.
            portAllocator: () => Effect.succeed(allocation.ports),
          },
        );
        const config: ResolvedDaemonConfig = {
          ...resolved,
          name: stack.name,
          projectDir: message.config.projectDir ?? message.workspacePath,
        };

        // Only a newly initialized child may remove a stale socket. A reuse
        // path must leave the already-running daemon's live socket untouched.
        await rm(message.socketPath, { force: true });

        if (dependencies.runtimeBootstrap !== undefined) {
          runtimes.portLease = allocation.lease;
          const metadata = await dependencies.runtimeBootstrap({
            stack,
            config,
            allocation,
            socketPath: message.socketPath,
          });
          await allocation.lease.handoff;
          return metadata;
        }

        const appLayer = foregroundDaemonLayer(config, platformFactory, allocation.lease);
        const appRuntime = ManagedRuntime.make(appLayer);
        runtimes.appRuntime = appRuntime;
        runtimes.portLease = allocation.lease;
        const localStack = await appRuntime.runPromise(Stack);
        await appRuntime.runPromise(LocalStackLifecycle);
        const daemonLayer = DaemonServer.layer.pipe(
          Layer.provide(Layer.succeed(Stack, localStack)),
          Layer.provide(daemonServerFactory(message.socketPath)),
        );
        const daemonRuntime = ManagedRuntime.make(daemonLayer);
        runtimes.daemonRuntime = daemonRuntime;
        await daemonRuntime.runPromise(DaemonServer);
        await allocation.lease.handoff;

        // Keep the app runtime alive for the detached process. Its lifecycle
        // owns the same lease and releases fields as services bind.
        return makeRuntimeMetadata(message.socketPath);
      },
    });

    const runtimeSocketPath = started.stack.runtimeMetadata.socketPath;
    if (!initialized && runtimeSocketPath === undefined) {
      throw new Error("Managed daemon reused a running stack without a runtime socket");
    }

    await sendManagedDaemonStarted(runtimeSocketPath ?? message.socketPath);
    startupAcknowledged = true;
    // Queue the acknowledgement before disconnecting the IPC channel. The
    // parent owns the child only until this publication acknowledgement.
    process.disconnect?.();

    if (!initialized) {
      await service.close();
      process.exit(0);
    }
    await Promise.race([
      waitForSignal(),
      ...(runtimes.daemonRuntime === undefined
        ? []
        : [
            runtimes.daemonRuntime
              .runPromise(DaemonServer)
              .then((daemon) => runtimes.daemonRuntime?.runPromise(daemon.awaitShutdown)),
          ]),
      ...(runtimes.appRuntime === undefined
        ? []
        : [
            runtimes.appRuntime
              .runPromise(LocalStackLifecycle)
              .then((lifecycle) => runtimes.appRuntime?.runPromise(lifecycle.awaitDisposed)),
          ]),
    ]);
    await service.updateStack(started.stack.id, { lifecycle: "stopped" });
    await shutdownManagedRuntime(runtimes);
    await service.close();
    process.exit(0);
  } catch (error) {
    const message =
      error instanceof Error && error.message.length > 0
        ? error.message
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();
    if (!startupAcknowledged && process.connected) {
      process.send?.({ type: "error", message });
    }
    await shutdownManagedRuntime(runtimes);
    await service?.close().catch(() => {});
    process.exit(1);
  }
}

const forkManagedDaemon = (
  entryPoint: string,
): Effect.Effect<ChildProcess, ManagedDaemonStartError> =>
  Effect.try({
    try: () =>
      fork(entryPoint, [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: true,
        env: { ...process.env, SUPABASE_STACK_RUN_MANAGED_DAEMON: "1" },
      }),
    catch: (cause) =>
      new ManagedDaemonStartError({
        message: `Failed to fork managed daemon: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const sendManagedDaemonStart = (
  child: ChildProcess,
  message: ManagedDaemonStartMessage,
): Effect.Effect<void, ManagedDaemonStartError> =>
  Effect.callback<void, ManagedDaemonStartError>((resume) => {
    try {
      child.send(message, (error) =>
        error === null
          ? resume(Effect.void)
          : resume(Effect.fail(new ManagedDaemonStartError({ message: error.message }))),
      );
    } catch (cause) {
      resume(
        Effect.fail(
          new ManagedDaemonStartError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      );
    }
    return Effect.void;
  });

const waitForManagedDaemonResponse = (
  child: ChildProcess,
): Effect.Effect<
  | {
      readonly type: "started";
      readonly socketPath: string;
    }
  | { readonly type: "error"; readonly message: string },
  ManagedDaemonStartError
> =>
  Effect.callback((resume) => {
    const onMessage = (message: unknown) => {
      cleanup();
      if (
        isRecord(message) &&
        message.type === "started" &&
        typeof message.socketPath === "string"
      ) {
        resume(Effect.succeed({ type: "started", socketPath: message.socketPath }));
      } else if (
        isRecord(message) &&
        message.type === "error" &&
        typeof message.message === "string"
      ) {
        resume(Effect.succeed({ type: "error", message: message.message }));
      } else {
        resume(
          Effect.fail(new ManagedDaemonStartError({ message: "Invalid managed daemon response" })),
        );
      }
    };
    const onError = (error: Error) => {
      cleanup();
      resume(Effect.fail(new ManagedDaemonStartError({ message: error.message })));
    };
    const onExit = (code: number | null) => {
      cleanup();
      resume(
        Effect.fail(
          new ManagedDaemonStartError({ message: `Managed daemon exited with code ${code}` }),
        ),
      );
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
    return Effect.sync(cleanup);
  });

/** Parent-side managed launcher. It does not open a registry or allocate ports. */
export const managedDaemonLayer = (
  input: ManagedDaemonStartInput,
  daemonEntryPoint: string,
): Effect.Effect<
  Layer.Layer<Stack>,
  ManagedDaemonStartError,
  FileSystem.FileSystem | Path.Path | UnixHttpClient
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const unixHttpClient = yield* UnixHttpClient;
    yield* fs
      .makeDirectory(dirname(input.socketPath), { recursive: true })
      .pipe(Effect.catchTag("PlatformError", (error) => Effect.die(error)));
    const child = yield* forkManagedDaemon(daemonEntryPoint);
    let registered = false;
    return yield* Effect.gen(function* () {
      const responseFiber = yield* waitForManagedDaemonResponse(child).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError(
          () =>
            new ManagedDaemonStartError({
              message: "Timed out waiting for managed daemon startup",
            }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* sendManagedDaemonStart(child, { ...input, type: "start" });
      const response = yield* Fiber.join(responseFiber);
      if (response.type === "error") {
        return yield* new ManagedDaemonStartError({ message: response.message });
      }
      child.unref();
      registered = true;
      // Detached ownership transfers to the child after the publication ack.
      // The parent must not terminate it when this RemoteStack layer is
      // disposed; callers stop the detached daemon explicitly through RPC.
      return RemoteStack.layer(response.socketPath).pipe(
        Layer.provide(Layer.succeed(UnixHttpClient, unixHttpClient)),
      );
    }).pipe(
      Effect.onExit(() =>
        registered
          ? Effect.void
          : Effect.promise(() => terminateChildProcess(child)).pipe(Effect.ignore),
      ),
    );
  });
