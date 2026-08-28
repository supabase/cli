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
  Option,
  Path,
  Result,
  Stream,
} from "effect";
import { HttpServer } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ApiProxy } from "./ApiProxy.ts";
import type { StackRuntimeSelection } from "./ContainerRuntime.ts";
import { candidateCleanupTargets, cleanupAutoManagedPaths, dockerForceRemove } from "./cleanup.ts";
import {
  StackBuildError,
  StackRpcProtocolError,
  StackRpcTransportError,
  StackUnavailableError,
  toStackError,
  type StackError,
} from "./errors.ts";
import type { FunctionsReloadConfig } from "./functions.ts";
import { foregroundLayer } from "./layers.ts";
import { LocalStackLifecycle } from "./LocalStack.ts";
import { PortAllocationError, reservePortSet, type PortLease } from "./PortAllocator.ts";
import { Stack } from "./Stack.ts";
import type { EdgeRuntimeReloadConfig } from "./Stack.ts";
import type { ReadyOptions, ResolvedStackConfig, StackConfig } from "./StackConfig.ts";
import { portRequestsForConfig, type ResolveConfigOptions } from "./StackConfigResolver.ts";
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

export type ResolveConfigEffect = (
  input: StackConfig | undefined,
  options: ResolveConfigOptions,
) => Effect.Effect<ResolvedStackConfig, StackBuildError, FileSystem.FileSystem>;

type CreateStackAttemptError =
  | StackBuildError
  | PortAllocationError
  | StackUnavailableError
  | StackRpcTransportError
  | StackRpcProtocolError;

/** The internal foreground handle; public adapters live at the package edge. */
export interface ForegroundStackHandle {
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly start: Effect.Effect<void, StackError>;
  readonly stop: Effect.Effect<void, StackError>;
  readonly dispose: Effect.Effect<void>;
  startService(name: string): Effect.Effect<void, StackError>;
  stopService(name: string): Effect.Effect<void, StackError>;
  restartService(name: string): Effect.Effect<void, StackError>;
  reloadFunctions(opts?: FunctionsReloadConfig): Effect.Effect<void, StackError>;
  reloadEdgeRuntime(opts: EdgeRuntimeReloadConfig): Effect.Effect<void, StackError>;
  ready(opts?: ReadyOptions): Effect.Effect<void, StackError>;
  serviceReady(name: string, opts?: ReadyOptions): Effect.Effect<void, StackError>;
  readonly getStatus: Effect.Effect<ReadonlyArray<StackServiceState>, StackError>;
  getServiceStatus(name: string): Effect.Effect<StackServiceState, StackError>;
  readonly statusChanges: Stream.Stream<StackServiceState, StackError>;
  readonly logs: Stream.Stream<LogEntry, StackError>;
  serviceLogs(name: string): Stream.Stream<LogEntry, StackError>;
  logHistory(name: string, limit?: number): Effect.Effect<ReadonlyArray<LogEntry>, StackError>;
}

/** @internal Converts operation failures and closes a terminal foreground runtime. */
export function runForegroundOperation<A, E>(
  operation: Effect.Effect<A, E>,
  isDisposed: Effect.Effect<boolean>,
  dispose: Effect.Effect<void>,
): Effect.Effect<A, StackError> {
  return operation.pipe(
    Effect.catch((error) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (yield* isDisposed) {
            yield* dispose;
          }
          return yield* toStackError(error);
        }),
      ),
    ),
  );
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

const causeIsAddressInUse = (cause: Cause.Cause<unknown>): boolean => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) return isAddressInUse(failure.value);
  const defect = Cause.findDefect(cause);
  return Result.isSuccess(defect) && isAddressInUse(defect.success);
};

const createStackAttempt = (
  config: StackConfig | undefined,
  platformFactory: PlatformFactory,
  runtimeSelection: StackRuntimeSelection,
  resolveConfig: ResolveConfigEffect,
  preferredApiPort?: number,
): Effect.Effect<ForegroundStackHandle, CreateStackAttemptError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    let portLease: PortLease | undefined;
    let resolved: ResolvedStackConfig | undefined;
    let disposeRuntime: Effect.Effect<void> | undefined;

    const cleanup = Effect.uninterruptible(
      Effect.gen(function* () {
        if (disposeRuntime !== undefined) {
          yield* disposeRuntime.pipe(Effect.ignore);
        }
        if (portLease !== undefined) {
          yield* portLease.releaseAll.pipe(Effect.ignore);
        }
        if (resolved === undefined) {
          return;
        }
        if (resolved.runtime.mode === "docker") {
          yield* dockerForceRemove(
            resolved.runtime.containerRuntime,
            candidateCleanupTargets(resolved).dockerContainerNames,
          ).pipe(Effect.ignore);
        }
        yield* cleanupAutoManagedPaths(resolved!.autoManagedPaths);
      }),
    );

    const attempt = Effect.gen(function* () {
      const requests = yield* portRequestsForConfig(config, {
        runtime: runtimeSelection,
        ...(preferredApiPort === undefined
          ? {}
          : { preferredPorts: { apiPort: preferredApiPort } }),
      });
      const lease = yield* reservePortSet(requests);
      portLease = lease;
      resolved = yield* resolveConfig(config, {
        runtime: runtimeSelection,
        ports: lease.ports,
      });

      const fullLayer = foregroundLayer(resolved, platformFactory, lease);
      const managedRuntime = ManagedRuntime.make(fullLayer);
      disposeRuntime = managedRuntime.disposeEffect;
      return yield* Effect.gen(function* () {
        const services = yield* managedRuntime.contextEffect;
        const localStack = Context.get(services, Stack);
        const apiProxy = Context.get(services, ApiProxy);
        const lifecycle = Context.get(services, LocalStackLifecycle);
        const info = yield* Effect.provideContext(localStack.getInfo, services);

        const disposalCompletion = Deferred.makeUnsafe<Exit.Exit<void, never>>();
        let disposalStarted = false;
        const awaitDisposal = Deferred.await(disposalCompletion).pipe(
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit) ? Effect.void : Effect.failCause(exit.cause),
          ),
        );
        const dispose = Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            if (disposalStarted) {
              return restore(awaitDisposal);
            }
            disposalStarted = true;
            return Effect.forkDetach(
              managedRuntime.disposeEffect.pipe(
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

        // The HTTP module has no response-flushed hook. Give the proxy's final
        // 503 response a brief opportunity to leave the socket before closing
        // the runtime after terminal lazy activation.
        managedRuntime.runFork(
          apiProxy.awaitTerminalFailure.pipe(
            Effect.andThen(Effect.sleep("25 millis")),
            Effect.andThen(dispose),
            Effect.ignoreCause,
          ),
        );

        return {
          url: info.url,
          dbUrl: info.dbUrl,
          publishableKey: info.publishableKey,
          secretKey: info.secretKey,
          start: run(localStack.start),
          stop: run(localStack.stop),
          dispose,
          startService: (name: string) => run(localStack.startService(name)),
          stopService: (name: string) => run(localStack.stopService(name)),
          restartService: (name: string) => run(localStack.restartService(name)),
          reloadFunctions: (opts?: FunctionsReloadConfig) => run(localStack.reloadFunctions(opts)),
          reloadEdgeRuntime: (opts: EdgeRuntimeReloadConfig) =>
            run(localStack.reloadEdgeRuntime(opts)),
          ready: (opts?: ReadyOptions) => run(localStack.waitAllReady(opts)),
          serviceReady: (name: string, opts?: ReadyOptions) =>
            run(localStack.waitReady(name, opts)),
          getStatus: run(localStack.getAllStates),
          getServiceStatus: (name: string) => run(localStack.getState(name)),
          statusChanges: localStack.allStateChanges.pipe(Stream.mapError(toStackError)),
          logs: localStack.subscribeAllLogs().pipe(Stream.mapError(toStackError)),
          serviceLogs: (name: string) =>
            localStack.subscribeLogs(name).pipe(Stream.mapError(toStackError)),
          logHistory: (name: string, limit?: number) => run(localStack.logHistory(name, limit)),
        } satisfies ForegroundStackHandle;
      });
    });

    return yield* attempt.pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : cleanup)),
    );
  });

export function createStack(
  config: StackConfig | undefined,
  platformFactory: PlatformFactory,
  runtime: StackRuntimeSelection,
  resolveConfig: ResolveConfigEffect,
): Effect.Effect<ForegroundStackHandle, StackError, FileSystem.FileSystem> {
  const automaticApiPort = config?.port === undefined;
  const loop = (
    attempt: number,
  ): Effect.Effect<ForegroundStackHandle, CreateStackAttemptError, FileSystem.FileSystem> =>
    createStackAttempt(
      config,
      platformFactory,
      runtime,
      resolveConfig,
      attempt === 0 ? undefined : 0,
    ).pipe(
      Effect.catchCause((cause) =>
        automaticApiPort &&
        causeIsAddressInUse(cause) &&
        attempt + 1 < MAX_AUTOMATIC_API_PORT_HANDOFF_ATTEMPTS
          ? Effect.suspend(() => loop(attempt + 1))
          : Effect.failCause(cause),
      ),
    );

  return loop(0).pipe(Effect.mapError(toStackError));
}
