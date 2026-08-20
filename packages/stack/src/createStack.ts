import type { LogEntry } from "@supabase/process-compose";
import { Context, Effect, FileSystem, type Layer, ManagedRuntime, Path, Stream } from "effect";
import { HttpServer } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ApiProxy } from "./ApiProxy.ts";
import type { StackRuntimeSelection } from "./ContainerRuntime.ts";
import { candidateCleanupTargets, cleanupAutoManagedPaths, dockerForceRemove } from "./cleanup.ts";
import { toStackError } from "./errors.ts";
import type { FunctionsReloadConfig } from "./functions.ts";
import { foregroundLayer } from "./layers.ts";
import { LocalStackLifecycle } from "./LocalStack.ts";
import { reservePortSet, type PortLease } from "./PortAllocator.ts";
import { Stack } from "./Stack.ts";
import type { EdgeRuntimeReloadConfig } from "./Stack.ts";
import type { ReadyOptions, ResolvedStackConfig, StackConfig } from "./StackConfig.ts";
import { resolveConfig } from "./StackConfigResolver.ts";
import type { StackServiceState } from "./StackServiceState.ts";

type PlatformServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpServer.HttpServer;

type PlatformLayer = Layer.Layer<PlatformServices>;
/** Supplies the platform HTTP server used by the stack and HTTP proxy. */
interface PlatformFactoryOptions {
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

const MAX_AUTOMATIC_API_PORT_HANDOFF_ATTEMPTS = 3;

/**
 * The port lease is intentionally released just before the HTTP server binds.
 * Another process can claim that port in the small handoff window, so a new
 * foreground stack may retry its automatic API-port allocation. Explicit API
 * ports never enter this retry path.
 */
const isAddressInUse = (error: unknown, depth = 0): boolean => {
  if (depth > 8 || typeof error !== "object" || error === null) return false;
  if ("code" in error && Reflect.get(error, "code") === "EADDRINUSE") return true;
  if ("cause" in error) return isAddressInUse(Reflect.get(error, "cause"), depth + 1);
  return false;
};

const createStackAttempt = async (
  config: StackConfig | undefined,
  platformFactory: PlatformFactory,
  runtime: StackRuntimeSelection,
  preferredApiPort?: number,
): Promise<StackHandle> => {
  let portLease: PortLease | undefined;
  let resolved: ResolvedStackConfig;
  try {
    resolved = await resolveConfig(config, {
      runtime,
      ...(preferredApiPort === undefined ? {} : { preferredPorts: { apiPort: preferredApiPort } }),
      portAllocator: (requests, options) =>
        reservePortSet(requests, options).pipe(
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

  try {
    const fullLayer = foregroundLayer(resolved, platformFactory, portLease);
    const runtime = ManagedRuntime.make(fullLayer);

    try {
      const services = await runtime.context();
      const localStack = Context.get(services, Stack);
      const apiProxy = Context.get(services, ApiProxy);
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

      // The HTTP module has no response-flushed hook. Give the proxy's final
      // 503 response a brief opportunity to leave the socket before closing
      // the runtime after terminal lazy activation.
      void runtime
        .runPromise(apiProxy.awaitTerminalFailure.pipe(Effect.andThen(Effect.sleep("25 millis"))))
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
    await Effect.runPromise(
      resolved.containerRuntime === null
        ? Effect.void
        : dockerForceRemove(
            resolved.containerRuntime,
            candidateCleanupTargets(resolved).dockerContainerNames,
          ),
    );
    cleanupAutoManagedPaths(resolved);
    throw toStackError(error);
  }
};

export async function createStack(
  config: StackConfig | undefined,
  platformFactory: PlatformFactory,
  runtime: StackRuntimeSelection,
): Promise<StackHandle> {
  const automaticApiPort = config?.port === undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      // Port zero asks the allocator for an OS-assigned automatic port,
      // avoiding another attempt at a contended default during handoff.
      return await createStackAttempt(
        config,
        platformFactory,
        runtime,
        attempt === 0 ? undefined : 0,
      );
    } catch (error) {
      if (
        !automaticApiPort ||
        !isAddressInUse(error) ||
        attempt + 1 >= MAX_AUTOMATIC_API_PORT_HANDOFF_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
}
