import { fork, type ChildProcess } from "node:child_process";
import { Data, Effect, Layer, Option } from "effect";
import { FileSystem, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ApiProxy, type ProxyConfig } from "./ApiProxy.ts";
import { BinaryResolver } from "./BinaryResolver.ts";
import type { PlatformFactory } from "./createStack.ts";
import type { DaemonMessage, DaemonStartMessage } from "./daemon.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { Stack } from "./Stack.ts";
import {
  NoRunningStackError,
  StackAlreadyRunningError,
  StateManager,
  singleStackStateManagerPaths,
  type StateManagerService,
} from "./StateManager.ts";
import { StackBuilder, type ResolvedStackConfig } from "./StackBuilder.ts";
import { resolveManagedStack } from "./managed-stack.ts";
import { terminateChildProcess } from "./terminateChild.ts";

/**
 * Build a foreground layer that runs the stack in-process.
 *
 * Wires: BinaryResolver → StackBuilder → Stack + ApiProxy + platform.
 * Returns a fully self-contained layer with no remaining requirements.
 */
export const foregroundLayer = (
  config: ResolvedStackConfig,
  platformFactory: PlatformFactory,
): Layer.Layer<Stack> => {
  const platform = platformFactory(config.apiPort);

  const binaryResolverLayer = BinaryResolver.make(config.cacheRoot).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
  const stackBuilderLayer = StackBuilder.layer.pipe(Layer.provide(binaryResolverLayer));
  const stackLayer = Stack.layer(config).pipe(Layer.provide(stackBuilderLayer));

  const proxyConfig: ProxyConfig = {
    listenPort: config.apiPort,
    gotruePort: config.auth !== false ? config.auth.port : 0,
    postgrestPort: config.postgrest !== false ? config.postgrest.port : 0,
    postgrestAdminPort: config.postgrest !== false ? config.postgrest.adminPort : 0,
    realtimePort: config.realtime !== false ? config.realtime.port : 0,
    storagePort: config.storage !== false ? config.storage.port : 0,
    pgmetaPort: config.pgmeta !== false ? config.pgmeta.port : 0,
    analyticsPort: config.analytics !== false ? config.analytics.port : 0,
    poolerPort: config.pooler !== false ? config.pooler.apiPort : 0,
    studioPort: config.studio !== false ? config.studio.port : 0,
    publishableKey: config.publishableKey,
    secretKey: config.secretKey,
    anonJwt: config.anonJwt,
    serviceRoleJwt: config.serviceRoleJwt,
  };
  const apiProxyLayer = ApiProxy.layer(proxyConfig).pipe(Layer.provide(FetchHttpClient.layer));

  return Layer.mergeAll(stackLayer, apiProxyLayer).pipe(Layer.provide(platform), Layer.orDie);
};

// ---------------------------------------------------------------------------
// Detached mode errors
// ---------------------------------------------------------------------------

export class DaemonStartError extends Data.TaggedError("DaemonStartError")<{
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Daemon-backed mode
// ---------------------------------------------------------------------------

export interface DaemonConfig extends ResolvedStackConfig {
  readonly name: string;
  readonly projectDir: string;
}

export const foregroundDaemonLayer = (
  config: DaemonConfig,
  platformFactory: PlatformFactory,
): Layer.Layer<Stack | StateManager> => {
  const platform = platformFactory(config.apiPort);

  const binaryResolverLayer = BinaryResolver.make(config.cacheRoot).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
  const stackBuilderLayer = StackBuilder.layer.pipe(Layer.provide(binaryResolverLayer));
  const stackLayer = Stack.layer(config).pipe(Layer.provide(stackBuilderLayer));

  const proxyConfig: ProxyConfig = {
    listenPort: config.apiPort,
    gotruePort: config.auth !== false ? config.auth.port : 0,
    postgrestPort: config.postgrest !== false ? config.postgrest.port : 0,
    postgrestAdminPort: config.postgrest !== false ? config.postgrest.adminPort : 0,
    realtimePort: config.realtime !== false ? config.realtime.port : 0,
    storagePort: config.storage !== false ? config.storage.port : 0,
    pgmetaPort: config.pgmeta !== false ? config.pgmeta.port : 0,
    analyticsPort: config.analytics !== false ? config.analytics.port : 0,
    poolerPort: config.pooler !== false ? config.pooler.apiPort : 0,
    studioPort: config.studio !== false ? config.studio.port : 0,
    publishableKey: config.publishableKey,
    secretKey: config.secretKey,
    anonJwt: config.anonJwt,
    serviceRoleJwt: config.serviceRoleJwt,
  };
  const apiProxyLayer = ApiProxy.layer(proxyConfig).pipe(Layer.provide(FetchHttpClient.layer));
  const stateManagerLayer = StateManager.make(
    singleStackStateManagerPaths(config.stackRoot, config.runtimeRoot, config.name),
  );

  return Layer.mergeAll(stackLayer, apiProxyLayer, stateManagerLayer).pipe(
    Layer.provide(platform),
    Layer.orDie,
  );
};

/**
 * Fork a daemon process and return a RemoteStack layer connected to it.
 *
 * 1. Computes socketPath via StateManager conventions
 * 2. Cleans up any stale socket file
 * 3. Forks `daemonEntryPoint` with IPC channel
 * 4. Sends DaemonStartMessage, waits for daemon startup confirmation
 * 5. Returns RemoteStack.layer(socketPath)
 */
export const daemonLayer = (
  config: DaemonConfig,
  daemonEntryPoint: string,
): Effect.Effect<
  Layer.Layer<Stack>,
  DaemonStartError | StackAlreadyRunningError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateManager = yield* StateManager.asEffect().pipe(
      Effect.provide(
        StateManager.make(
          singleStackStateManagerPaths(config.stackRoot, config.runtimeRoot, config.name),
        ),
      ),
    );

    // Check if a stack with this name is already running
    const existingState = yield* stateManager.read(config.name).pipe(Effect.option);
    if (Option.isSome(existingState)) {
      const alive = yield* stateManager.isAlive(existingState.value);
      if (alive) {
        return yield* new StackAlreadyRunningError({
          name: config.name,
          pid: existingState.value.pid,
          message: `A Supabase stack "${config.name}" is already running (PID ${existingState.value.pid}). Use "supabase stop" first.`,
        });
      }
      // Stale state from a dead daemon — clean up before proceeding
      yield* stateManager.remove(config.name);
    }

    // Compute socket path via StateManager conventions
    const dir = stateManager.stackDir(config.name);
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
    const runtimeDir = stateManager.runtimeDir(config.name);
    yield* fs
      .makeDirectory(runtimeDir, { recursive: true })
      .pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
    const socketPath = stateManager.socketPath(config.name);

    // Clean up stale socket file if present
    yield* fs.remove(socketPath).pipe(Effect.ignore);

    let daemonRegistered = false;
    const child = yield* forkDaemon(daemonEntryPoint);

    return yield* Effect.gen(function* () {
      const startMsg: DaemonStartMessage = {
        type: "start",
        config,
        name: config.name,
        projectDir: config.projectDir,
        socketPath,
      };
      child.send(startMsg);

      const response = yield* waitForDaemonResponse(child);

      if (response.type === "error") {
        return yield* new DaemonStartError({ message: response.message });
      }

      // Only unref once the daemon confirms it has fully initialized and
      // registered its own state. Until then, the parent owns cleanup.
      child.unref();
      daemonRegistered = true;

      return RemoteStack.layer(socketPath);
    }).pipe(
      Effect.onExit(() =>
        daemonRegistered
          ? Effect.void
          : cleanupPendingDaemonStartup(child, stateManager, config.name),
      ),
    );
  });

/** Fork a child process with IPC channel. */
const forkDaemon = (entryPoint: string): Effect.Effect<ChildProcess, DaemonStartError> =>
  Effect.try({
    try: () =>
      fork(entryPoint, [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: true,
      }),
    catch: (e) =>
      new DaemonStartError({
        message: `Failed to fork daemon: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });

/** Wait for DaemonStartedMessage or DaemonErrorMessage from the child. */
const waitForDaemonResponse = (
  child: ChildProcess,
): Effect.Effect<DaemonMessage, DaemonStartError> =>
  Effect.callback<DaemonMessage, DaemonStartError>((resume) => {
    const onMessage = (msg: unknown) => {
      cleanup();
      resume(Effect.succeed(msg as DaemonMessage));
    };

    const onError = (err: Error) => {
      cleanup();
      resume(
        Effect.fail(new DaemonStartError({ message: `Daemon process error: ${err.message}` })),
      );
    };

    const onExit = (code: number | null) => {
      cleanup();
      resume(Effect.fail(new DaemonStartError({ message: `Daemon exited with code ${code}` })));
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

const cleanupPendingDaemonStartup = (
  child: ChildProcess,
  stateManager: StateManagerService,
  stackName: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => terminateChildProcess(child)).pipe(Effect.catch(() => Effect.void));
    yield* stateManager.remove(stackName);
  });

// ---------------------------------------------------------------------------
// Connect mode
// ---------------------------------------------------------------------------

/**
 * Connect to an already-running daemon by resolving its state from the filesystem.
 *
 * Looks up the running stack for the given name or working directory,
 * verifies it's still alive, and returns a RemoteStack layer.
 */
export const connectLayer = (opts: {
  name?: string;
  cwd?: string;
  cacheRoot: string;
}): Effect.Effect<Layer.Layer<Stack>, NoRunningStackError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const cwd = opts.cwd ?? process.cwd();
    const { state, alive } = yield* resolveManagedStack(opts);
    if (!alive) {
      return yield* new NoRunningStackError({ cwd });
    }

    return RemoteStack.layer(state.socketPath);
  });
