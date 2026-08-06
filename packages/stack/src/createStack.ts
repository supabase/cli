import type { LogEntry } from "@supabase/process-compose";
import { Context, Effect, type Layer, ManagedRuntime, Stream } from "effect";
import { FileSystem, Path } from "effect";
import { HttpServer } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { candidateCleanupTargets, cleanupAutoManagedPaths, dockerForceRemove } from "./cleanup.ts";
import { toStackError } from "./errors.ts";
import type { FunctionsReloadConfig } from "./functions.ts";
import { daemonLayer, foregroundLayer, type DaemonStartError } from "./layers.ts";
import { LocalStackLifecycle } from "./LocalStack.ts";
import { PORT_FIELDS, reservePorts, type PortLease } from "./PortAllocator.ts";
import { allocatedPortFieldsForConfig } from "./ServicePorts.ts";
import { Stack } from "./Stack.ts";
import type { EdgeRuntimeReloadConfig } from "./Stack.ts";
import type { ReadyOptions, ResolvedStackConfig, StackConfig } from "./StackConfig.ts";
import { resolveConfig } from "./StackConfigResolver.ts";
import type { StackServiceState } from "./StackServiceState.ts";
import { InvalidStackStateError, StackAlreadyRunningError } from "./StateManager.ts";
import { UnixHttpClient } from "./UnixHttpClient.ts";

export type PlatformServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpServer.HttpServer;

export type PlatformLayer = Layer.Layer<PlatformServices>;
/** Supplies the platform HTTP server used by the stack and HTTP proxy. */
export interface PlatformFactoryOptions {
  readonly apiPort: number;
  readonly releaseApiPort: Effect.Effect<void>;
}

export type PlatformFactory = (options: PlatformFactoryOptions) => PlatformLayer;

/** @internal Converts operation failures and closes a terminal foreground runtime. */
export async function runForegroundOperation<A>(
  operation: Promise<A>,
  isDisposed: () => Promise<boolean>,
  dispose: () => Promise<void>,
): Promise<A> {
  try {
    return await operation;
  } catch (error: unknown) {
    const stackError = toStackError(error);
    if (await isDisposed()) {
      await dispose();
    }
    throw stackError;
  }
}

export interface StackHandle extends AsyncDisposable {
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  startService(name: string): Promise<void>;
  stopService(name: string): Promise<void>;
  restartService(name: string): Promise<void>;
  reloadFunctions(opts?: FunctionsReloadConfig): Promise<void>;
  reloadEdgeRuntime(opts: EdgeRuntimeReloadConfig): Promise<void>;
  ready(opts?: ReadyOptions): Promise<void>;
  serviceReady(name: string, opts?: ReadyOptions): Promise<void>;
  getStatus(): Promise<ReadonlyArray<StackServiceState>>;
  getServiceStatus(name: string): Promise<StackServiceState>;
  statusChanges(): AsyncIterable<StackServiceState>;
  logs(): AsyncIterable<LogEntry>;
  serviceLogs(name: string): AsyncIterable<LogEntry>;
  logHistory(name: string, limit?: number): Promise<ReadonlyArray<LogEntry>>;
}

export const projectDaemonLayer = (opts: {
  readonly cacheRoot: string;
  readonly cwd: string;
  readonly projectDir?: string;
  readonly projectStateRoot?: string;
  readonly name?: string;
  readonly daemonEntryPoint: string;
  readonly stackConfig?: Omit<StackConfig, "cacheRoot" | "stackRoot" | "runtimeRoot" | "functions">;
}): Effect.Effect<
  Layer.Layer<Stack>,
  DaemonStartError | InvalidStackStateError | StackAlreadyRunningError,
  FileSystem.FileSystem | Path.Path | UnixHttpClient
> =>
  daemonLayer(
    {
      cacheRoot: opts.cacheRoot,
      cwd: opts.cwd,
      projectDir: opts.projectDir,
      projectStateRoot: opts.projectStateRoot,
      name: opts.name,
      ...opts.stackConfig,
    },
    opts.daemonEntryPoint,
  );

export async function createStack(
  config: StackConfig | undefined,
  platformFactory: PlatformFactory,
): Promise<StackHandle> {
  let portLease: PortLease | undefined;
  let resolved: ResolvedStackConfig;
  try {
    resolved = await resolveConfig(config, {
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
  } catch (error: unknown) {
    if (portLease !== undefined) {
      await Effect.runPromise(portLease.releaseAll);
    }
    throw error;
  }

  if (portLease === undefined) {
    throw new Error("Stack port allocation completed without a port lease");
  }

  const activeFields = new Set(allocatedPortFieldsForConfig(resolved));
  const unusedFields = PORT_FIELDS.filter((field) => !activeFields.has(field));
  await Effect.runPromise(portLease.release(unusedFields));

  try {
    const fullLayer = foregroundLayer(resolved, platformFactory, portLease);
    const runtime = ManagedRuntime.make(fullLayer);

    try {
      const services = await runtime.context();
      const localStack = Context.get(services, Stack);
      const lifecycle = Context.get(services, LocalStackLifecycle);
      const info = await runtime.runPromise(localStack.getInfo());

      let disposal: Promise<void> | undefined;
      const gracefulDispose = () => {
        disposal ??= runtime.dispose().catch(() => {});
        return disposal;
      };
      const run = <A>(effect: Effect.Effect<A, unknown>) =>
        runForegroundOperation(
          runtime.runPromise(effect),
          () => runtime.runPromise(lifecycle.isDisposed),
          gracefulDispose,
        );

      // LocalStack owns terminality. When it disposes, close the enclosing
      // runtime as well so the public API port cannot outlive the stack.
      void runtime
        .runPromise(lifecycle.awaitDisposed)
        .then(gracefulDispose)
        .catch(() => {});

      const stack: StackHandle = {
        url: info.url,
        dbUrl: info.dbUrl,
        publishableKey: info.publishableKey,
        secretKey: info.secretKey,
        start: () => run(localStack.start()),
        stop: () => run(localStack.stop()),
        dispose: gracefulDispose,
        startService: (name) => run(localStack.startService(name)),
        stopService: (name) => run(localStack.stopService(name)),
        restartService: (name) => run(localStack.restartService(name)),
        reloadFunctions: (opts) => run(localStack.reloadFunctions(opts)),
        reloadEdgeRuntime: (opts) => run(localStack.reloadEdgeRuntime(opts)),
        ready: (opts) => run(localStack.waitAllReady(opts)),
        serviceReady: (name, opts) => run(localStack.waitReady(name, opts)),
        getStatus: () => run(localStack.getAllStates()),
        getServiceStatus: (name) => run(localStack.getState(name)),
        statusChanges: () => Stream.toAsyncIterableWith(localStack.allStateChanges(), services),
        logs: () => Stream.toAsyncIterableWith(localStack.subscribeAllLogs(), services),
        serviceLogs: (name) => Stream.toAsyncIterableWith(localStack.subscribeLogs(name), services),
        logHistory: (name, limit) => run(localStack.logHistory(name, limit)),
        [Symbol.asyncDispose]: gracefulDispose,
      };

      return stack;
    } catch (error: unknown) {
      await runtime.dispose().catch(() => {});
      throw error;
    }
  } catch (error: unknown) {
    await Effect.runPromise(portLease.releaseAll);
    dockerForceRemove(candidateCleanupTargets(resolved).dockerContainerNames);
    cleanupAutoManagedPaths(resolved);
    throw toStackError(error);
  }
}
