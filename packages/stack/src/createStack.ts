import type { LogEntry } from "@supabase/process-compose";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  type Layer,
  ManagedRuntime,
  Path,
  Stream,
} from "effect";
import { HttpServer } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ApiProxy } from "./ApiProxy.ts";
import { candidateCleanupTargets, cleanupAutoManagedPaths, dockerForceRemove } from "./cleanup.ts";
import { toStackError, type StackError } from "./errors.ts";
import type { FunctionsReloadConfig } from "./functions.ts";
import { foregroundLayer } from "./layers.ts";
import { LocalStackLifecycle } from "./LocalStack.ts";
import { reservePortSet } from "./PortAllocator.ts";
import { Stack } from "./Stack.ts";
import type { EdgeRuntimeReloadConfig } from "./Stack.ts";
import type { ReadyOptions, ResolvedStackConfig, StackConfig } from "./StackConfig.ts";
import { portRequestsForConfig, resolveConfig } from "./StackConfigResolver.ts";
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

/** The Effect-native foreground handle. Promise adapters are defined at node.ts/bun.ts. */
export interface ForegroundStackHandle {
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  start(): Effect.Effect<void, StackError>;
  stop(): Effect.Effect<void, StackError>;
  dispose(): Effect.Effect<void>;
  startService(name: string): Effect.Effect<void, StackError>;
  stopService(name: string): Effect.Effect<void, StackError>;
  restartService(name: string): Effect.Effect<void, StackError>;
  reloadFunctions(opts?: FunctionsReloadConfig): Effect.Effect<void, StackError>;
  reloadEdgeRuntime(opts: EdgeRuntimeReloadConfig): Effect.Effect<void, StackError>;
  ready(opts?: ReadyOptions): Effect.Effect<void, StackError>;
  serviceReady(name: string, opts?: ReadyOptions): Effect.Effect<void, StackError>;
  getStatus(): Effect.Effect<ReadonlyArray<StackServiceState>, StackError>;
  getServiceStatus(name: string): Effect.Effect<StackServiceState, StackError>;
  statusChanges(): Stream.Stream<StackServiceState>;
  logs(): Stream.Stream<LogEntry>;
  serviceLogs(name: string): Stream.Stream<LogEntry>;
  logHistory(name: string, limit?: number): Effect.Effect<ReadonlyArray<LogEntry>, StackError>;
}

export function runForegroundOperation<A, E>(
  operation: Effect.Effect<A, E>,
  isDisposed: Effect.Effect<boolean>,
  dispose: Effect.Effect<void>,
): Effect.Effect<A, StackError> {
  return operation.pipe(
    Effect.catch((error) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (yield* isDisposed) yield* dispose;
          return yield* Effect.fail(toStackError(error));
        }),
      ),
    ),
  );
}

const isAddressInUse = (error: unknown, depth = 0): boolean => {
  if (depth > 8 || typeof error !== "object" || error === null) return false;
  if ("code" in error && Reflect.get(error, "code") === "EADDRINUSE") return true;
  if ("cause" in error) return isAddressInUse(Reflect.get(error, "cause"), depth + 1);
  return false;
};

const createStackAttempt = (
  config: StackConfig | undefined,
  platformFactory: PlatformFactory,
  disableApiPreference: boolean,
): Effect.Effect<ForegroundStackHandle, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    let lease: import("./PortAllocator.ts").PortLease | undefined;
    let resolved: ResolvedStackConfig | undefined;
    let disposeRuntime: Effect.Effect<void> | undefined;

    const cleanup = Effect.uninterruptible(
      Effect.gen(function* () {
        if (disposeRuntime !== undefined) yield* disposeRuntime.pipe(Effect.ignore);
        if (lease !== undefined) yield* lease.releaseAll.pipe(Effect.ignore);
        const configForCleanup = resolved;
        if (configForCleanup !== undefined) {
          yield* dockerForceRemove(
            candidateCleanupTargets(configForCleanup).dockerContainerNames,
          ).pipe(Effect.ignore);
          yield* cleanupAutoManagedPaths(configForCleanup);
        }
      }),
    );

    const attempt = Effect.gen(function* () {
      const requests = yield* portRequestsForConfig(
        config,
        disableApiPreference ? { disablePreferredPorts: new Set(["apiPort"]) } : {},
      );
      lease = yield* reservePortSet(requests);
      resolved = yield* resolveConfig(config, { ports: lease.ports });

      const runtime = ManagedRuntime.make(foregroundLayer(resolved, platformFactory, lease));
      disposeRuntime = runtime.disposeEffect;
      const services = yield* runtime.contextEffect;
      const localStack = Context.get(services, Stack);
      const apiProxy = Context.get(services, ApiProxy);
      const lifecycle = Context.get(services, LocalStackLifecycle);
      const info = yield* Effect.provideContext(localStack.getInfo(), services);
      const disposalCompletion = Deferred.makeUnsafe<Exit.Exit<void, never>>();
      let disposalStarted = false;
      const awaitDisposal = Deferred.await(disposalCompletion).pipe(
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Effect.failCause(exit.cause),
        ),
      );
      // A detached fiber owns teardown so one caller's interruption cannot
      // cancel it; every concurrent caller joins the same completion signal.
      const dispose = Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (disposalStarted) return restore(awaitDisposal);
          disposalStarted = true;
          return Effect.forkDetach(
            runtime.disposeEffect.pipe(
              Effect.uninterruptible,
              Effect.exit,
              Effect.flatMap((exit) => Deferred.succeed(disposalCompletion, exit)),
              Effect.asVoid,
            ),
            { startImmediately: true },
          ).pipe(Effect.asVoid, Effect.andThen(restore(awaitDisposal)));
        }),
      );
      const run = <A, E>(effect: Effect.Effect<A, E>) =>
        runForegroundOperation(
          Effect.provideContext(effect, services),
          Effect.provideContext(lifecycle.isDisposed, services),
          dispose,
        );

      // The HTTP module has no response-flushed hook. Scope this fiber to the
      // managed runtime; disposal remains shared and idempotent for callers.
      runtime.runFork(
        apiProxy.awaitTerminalFailure.pipe(
          Effect.andThen(Effect.sleep("25 millis")),
          Effect.andThen(dispose),
          Effect.catchCause(() => Effect.void),
        ),
      );

      return {
        url: info.url,
        dbUrl: info.dbUrl,
        publishableKey: info.publishableKey,
        secretKey: info.secretKey,
        start: () => run(localStack.start()),
        stop: () => run(localStack.stop()),
        dispose: () => dispose,
        startService: (name) => run(localStack.startService(name)),
        stopService: (name) => run(localStack.stopService(name)),
        restartService: (name) => run(localStack.restartService(name)),
        reloadFunctions: (opts) => run(localStack.reloadFunctions(opts)),
        reloadEdgeRuntime: (opts) => run(localStack.reloadEdgeRuntime(opts)),
        ready: (opts) => run(localStack.waitAllReady(opts)),
        serviceReady: (name, opts) => run(localStack.waitReady(name, opts)),
        getStatus: () => run(localStack.getAllStates()),
        getServiceStatus: (name) => run(localStack.getState(name)),
        statusChanges: () => localStack.allStateChanges(),
        logs: () => localStack.subscribeAllLogs(),
        serviceLogs: (name) => localStack.subscribeLogs(name),
        logHistory: (name, limit) => run(localStack.logHistory(name, limit)),
      } satisfies ForegroundStackHandle;
    });

    return yield* attempt.pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : cleanup)),
    );
  });

export function createStack(
  config: StackConfig | undefined,
  platformFactory: PlatformFactory,
): Effect.Effect<ForegroundStackHandle, StackError, FileSystem.FileSystem> {
  const automaticApiPort = config?.port === undefined;
  const loop = (
    attempt: number,
  ): Effect.Effect<ForegroundStackHandle, unknown, FileSystem.FileSystem> =>
    createStackAttempt(config, platformFactory, attempt > 0).pipe(
      Effect.catchCause((cause) =>
        automaticApiPort && isAddressInUse(Cause.squash(cause)) && attempt < 2
          ? Effect.suspend(() => loop(attempt + 1))
          : Effect.failCause(cause),
      ),
    );
  return loop(0).pipe(Effect.mapError(toStackError));
}
