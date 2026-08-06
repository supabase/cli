import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Data, Effect, Fiber, Layer, Option, Schema } from "effect";
import { FileSystem, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ApiProxy, type ProxyConfig } from "./ApiProxy.ts";
import { BinaryResolver } from "./BinaryResolver.ts";
import type { PlatformFactory } from "./createStack.ts";
import type { DaemonMessage, DaemonStartMessage } from "./daemon.ts";
import { DaemonMessageSchema } from "./DaemonProtocol.ts";
import type { PortLease } from "./PortAllocator.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { Stack } from "./Stack.ts";
import { LocalStackLifecycle, localStackLayer } from "./LocalStack.ts";
import { StackMetadataPersistence } from "./StackMetadataPersistence.ts";
import { StackPreparation } from "./StackPreparation.ts";
import {
  InvalidStackStateError,
  NoRunningStackError,
  StackAlreadyRunningError,
  StateManager,
  singleStackStateManagerPaths,
} from "./StateManager.ts";
import { StackBuilder } from "./StackBuilder.ts";
import type { ResolvedDaemonConfig, ResolvedStackConfig } from "./StackConfig.ts";
import type { DaemonConfigInput } from "./StackConfigResolver.ts";
import { UnixHttpClient } from "./UnixHttpClient.ts";
import { resolveManagedStack } from "./managed-stack.ts";
import {
  DEFAULT_MANAGED_STACK_NAME,
  defaultCacheRoot,
  defaultManagedRuntimeRoot,
  defaultManagedStackRoot,
} from "./paths.ts";
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
  portLease: PortLease,
): Layer.Layer<Stack | ApiProxy | LocalStackLifecycle> => {
  const platform = platformFactory({
    apiPort: config.apiPort,
    releaseApiPort: portLease.release(["apiPort"]),
  });

  const binaryResolverLayer = BinaryResolver.make(config.cacheRoot).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
  const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(binaryResolverLayer));
  const stackLayer = localStackLayer(config, portLease).pipe(
    Layer.provide(StackBuilder.layer),
    Layer.provide(stackPreparationLayer),
    Layer.provide(StackMetadataPersistence.noop),
  );

  const proxyConfig: ProxyConfig = {
    listenPort: config.apiPort,
    gotruePort: config.auth !== false ? config.auth.port : 0,
    postgrestPort: config.postgrest !== false ? config.postgrest.port : 0,
    postgrestAdminPort: config.postgrest !== false ? config.postgrest.adminPort : 0,
    edgeRuntimePort: config.edgeRuntime !== false ? config.edgeRuntime.port : 0,
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
  const apiProxyLayer = ApiProxy.layer(proxyConfig).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(stackLayer),
  );

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

export const foregroundDaemonLayer = (
  config: ResolvedDaemonConfig,
  platformFactory: PlatformFactory,
  portLease: PortLease,
): Layer.Layer<Stack | StateManager | ApiProxy> => {
  const platform = platformFactory({
    apiPort: config.apiPort,
    releaseApiPort: portLease.release(["apiPort"]),
  });

  const binaryResolverLayer = BinaryResolver.make(config.cacheRoot).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
  const proxyConfig: ProxyConfig = {
    listenPort: config.apiPort,
    gotruePort: config.auth !== false ? config.auth.port : 0,
    postgrestPort: config.postgrest !== false ? config.postgrest.port : 0,
    postgrestAdminPort: config.postgrest !== false ? config.postgrest.adminPort : 0,
    edgeRuntimePort: config.edgeRuntime !== false ? config.edgeRuntime.port : 0,
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
  const stateManagerLayer = StateManager.make(
    singleStackStateManagerPaths(config.stackRoot, config.runtimeRoot, config.name),
  );
  const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(binaryResolverLayer));
  const metadataPersistenceLayer = StackMetadataPersistence.fromStateManager(config.name).pipe(
    Layer.provide(stateManagerLayer),
  );
  const stackLayer = localStackLayer(config, portLease).pipe(
    Layer.provide(StackBuilder.layer),
    Layer.provide(stackPreparationLayer),
    Layer.provide(metadataPersistenceLayer),
  );
  const apiProxyLayer = ApiProxy.layer(proxyConfig).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(stackLayer),
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
  input: DaemonConfigInput,
  daemonEntryPoint: string,
): Effect.Effect<
  Layer.Layer<Stack>,
  DaemonStartError | InvalidStackStateError | StackAlreadyRunningError,
  FileSystem.FileSystem | Path.Path | UnixHttpClient
> =>
  Effect.gen(function* () {
    if (input.stackRoot !== undefined || input.runtimeRoot !== undefined) {
      return yield* new DaemonStartError({
        message: "Managed daemon stacks derive stackRoot and runtimeRoot automatically",
      });
    }
    const projectDir = input.projectDir ?? input.cwd;
    const name = input.name ?? DEFAULT_MANAGED_STACK_NAME;
    const cacheRoot = input.cacheRoot ?? defaultCacheRoot();
    const stackRoot =
      input.projectStateRoot !== undefined
        ? join(input.projectStateRoot, "stacks", name)
        : defaultManagedStackRoot(cacheRoot, projectDir, name);
    const runtimeRoot = defaultManagedRuntimeRoot(stackRoot);
    const config: DaemonConfigInput = {
      ...input,
      cacheRoot,
      projectDir,
      name,
    };
    const fs = yield* FileSystem.FileSystem;
    const unixHttpClient = yield* UnixHttpClient;
    const stateManager = yield* StateManager.pipe(
      Effect.provide(StateManager.make(singleStackStateManagerPaths(stackRoot, runtimeRoot, name))),
    );

    // Check if a stack with this name is already running
    const existingState = yield* stateManager.read(name).pipe(
      Effect.map(Option.some),
      Effect.catchTag("StateNotFoundError", () => Effect.succeed(Option.none())),
    );
    if (Option.isSome(existingState)) {
      const alive = yield* stateManager.isAlive(existingState.value);
      if (alive) {
        return yield* new StackAlreadyRunningError({
          name,
          pid: existingState.value.pid,
          message: `A Supabase stack "${config.name}" is already running (PID ${existingState.value.pid}). Use "supabase stop" first.`,
        });
      }
      // Stale state from a dead daemon — clean up before proceeding
      yield* stateManager.remove(name);
    }

    // Compute socket path via StateManager conventions
    const dir = stateManager.stackDir(name);
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
    const runtimeDir = stateManager.runtimeDir(name);
    yield* fs
      .makeDirectory(runtimeDir, { recursive: true })
      .pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
    // A daemon generation owns its socket pathname for its entire lifetime.
    // Reusing a fixed pathname lets a delayed shutdown unlink a replacement
    // daemon's socket after the replacement has already bound it.
    const socketPath = join(runtimeDir, `daemon-${randomUUID().slice(0, 12)}.sock`);

    // Clean up stale socket file if present
    yield* fs.remove(socketPath).pipe(Effect.ignore);

    let daemonRegistered = false;
    const child = yield* forkDaemon(daemonEntryPoint);

    return yield* Effect.gen(function* () {
      const startMsg: DaemonStartMessage = {
        type: "start",
        config,
        socketPath,
      };
      const responseFiber = yield* waitForDaemonResponse(child).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((error) =>
          error._tag === "DaemonStartError"
            ? error
            : new DaemonStartError({ message: "Timed out waiting for daemon startup" }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* sendDaemonStart(child, startMsg);
      const response = yield* Fiber.join(responseFiber);

      if (response.type === "error") {
        return yield* new DaemonStartError({ message: response.message });
      }

      // Only unref once the daemon confirms it has fully initialized and
      // registered its own state. Until then, the parent owns cleanup.
      child.unref();
      daemonRegistered = true;

      return RemoteStack.layer(response.state.socketPath).pipe(
        Layer.provide(Layer.succeed(UnixHttpClient, unixHttpClient)),
      );
    }).pipe(
      Effect.onExit(() => (daemonRegistered ? Effect.void : cleanupPendingDaemonStartup(child))),
    );
  });

/** Fork a child process with IPC channel. */
const forkDaemon = (entryPoint: string): Effect.Effect<ChildProcess, DaemonStartError> =>
  Effect.try({
    try: () =>
      fork(entryPoint, [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: true,
        env: {
          ...process.env,
          SUPABASE_STACK_RUN_DAEMON: "1",
        },
      }),
    catch: (e) =>
      new DaemonStartError({
        message: `Failed to fork daemon: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });

const sendDaemonStart = (
  child: ChildProcess,
  message: DaemonStartMessage,
): Effect.Effect<void, DaemonStartError> =>
  Effect.callback<void, DaemonStartError>((resume) => {
    try {
      child.send(message, (error) => {
        if (error === null) {
          resume(Effect.void);
          return;
        }
        resume(
          Effect.fail(
            new DaemonStartError({ message: `Failed to send daemon config: ${error.message}` }),
          ),
        );
      });
    } catch (cause) {
      resume(
        Effect.fail(
          new DaemonStartError({
            message: `Failed to send daemon config: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
        ),
      );
    }
    return Effect.void;
  });

/** Wait for DaemonStartedMessage or DaemonErrorMessage from the child. */
const waitForDaemonResponse = (
  child: ChildProcess,
): Effect.Effect<DaemonMessage, DaemonStartError> =>
  Effect.callback<DaemonMessage, DaemonStartError>((resume) => {
    const onMessage = (msg: unknown) => {
      cleanup();
      const decoded = Schema.decodeUnknownOption(DaemonMessageSchema)(msg);
      resume(
        Option.isSome(decoded)
          ? Effect.succeed(decoded.value)
          : Effect.fail(new DaemonStartError({ message: "Daemon sent an invalid IPC response" })),
      );
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

const cleanupPendingDaemonStartup = (child: ChildProcess): Effect.Effect<void> =>
  Effect.promise(() => terminateChildProcess(child)).pipe(Effect.catch(() => Effect.void));

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
  projectDir?: string;
  projectStateRoot?: string;
}): Effect.Effect<
  Layer.Layer<Stack>,
  NoRunningStackError | InvalidStackStateError,
  FileSystem.FileSystem | Path.Path | UnixHttpClient
> =>
  Effect.gen(function* () {
    const cwd = opts.cwd ?? process.cwd();
    const unixHttpClient = yield* UnixHttpClient;
    const { state, alive } = yield* resolveManagedStack(opts);
    if (!alive) {
      return yield* new NoRunningStackError({ cwd });
    }

    return RemoteStack.layer(state.socketPath).pipe(
      Layer.provide(Layer.succeed(UnixHttpClient, unixHttpClient)),
    );
  });
