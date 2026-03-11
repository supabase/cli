import { LogBuffer, Orchestrator } from "@supabase/process-compose";
import type {
  LogEntry,
  ServiceNotFoundError,
  ServiceReadyError,
  ServiceState,
} from "@supabase/process-compose";
import { Effect, Layer, ServiceMap, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { cleanupLocalStackResources } from "./cleanup.ts";
import { StackBuildError } from "./errors.ts";
import { StackBuilder, type ResolvedStackConfig } from "./StackBuilder.ts";

export interface StackInfo {
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
  readonly dockerContainerNames: ReadonlyArray<string>;
}

export type StackService = ServiceMap.Service.Shape<typeof Stack>;

export class Stack extends ServiceMap.Service<
  Stack,
  {
    readonly getInfo: () => Effect.Effect<StackInfo>;
    readonly start: () => Effect.Effect<void, ServiceReadyError>;
    readonly stop: () => Effect.Effect<void>;
    readonly dispose: () => Effect.Effect<void>;
    readonly startService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError>;
    readonly stopService: (name: string) => Effect.Effect<void, ServiceNotFoundError>;
    readonly restartService: (name: string) => Effect.Effect<void, ServiceNotFoundError>;
    readonly getState: (name: string) => Effect.Effect<ServiceState, ServiceNotFoundError>;
    readonly getAllStates: () => Effect.Effect<ReadonlyArray<ServiceState>>;
    readonly stateChanges: (
      name: string,
    ) => Effect.Effect<Stream.Stream<ServiceState>, ServiceNotFoundError>;
    readonly allStateChanges: () => Stream.Stream<ServiceState>;
    readonly waitReady: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError>;
    readonly waitAllReady: () => Effect.Effect<void, ServiceReadyError>;
    readonly subscribeLogs: (name: string) => Stream.Stream<LogEntry>;
    readonly subscribeAllLogs: (services?: ReadonlyArray<string>) => Stream.Stream<LogEntry>;
    readonly logHistory: (name: string, limit?: number) => Effect.Effect<ReadonlyArray<LogEntry>>;
    readonly logHistoryAll: (
      limit?: number,
      services?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LogEntry>>;
  }
>()("stack/Stack") {
  static layer = (
    config: ResolvedStackConfig,
  ): Layer.Layer<Stack, StackBuildError, StackBuilder | ChildProcessSpawner.ChildProcessSpawner> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const builder = yield* StackBuilder;
        const { graph, dockerContainerNames } = yield* builder.build(config);

        // Get the current scope so sub-layers' scoped resources (FiberMap,
        // PubSub, etc.) stay alive for the lifetime of Stack.
        const scope = yield* Effect.scope;

        // Create LogBuffer within the current scope
        const logBufferServices = yield* Layer.buildWithScope(LogBuffer.layer, scope);
        const logBuffer = ServiceMap.get(logBufferServices, LogBuffer);

        // Build orchestrator within the current scope, with shared LogBuffer
        const orchLayer = Orchestrator.layer(graph).pipe(
          Layer.provide(Layer.succeed(LogBuffer, logBuffer)),
        );
        const orchServices = yield* Layer.buildWithScope(orchLayer, scope);
        const orchestrator = ServiceMap.get(orchServices, Orchestrator);

        const info: StackInfo = {
          url: `http://127.0.0.1:${config.apiPort}`,
          dbUrl: `postgresql://postgres:postgres@127.0.0.1:${config.dbPort}/postgres`,
          publishableKey: config.publishableKey,
          secretKey: config.secretKey,
          anonJwt: config.anonJwt,
          serviceRoleJwt: config.serviceRoleJwt,
          dockerContainerNames,
        };

        let disposed = false;
        const disposeOnce = () =>
          Effect.gen(function* () {
            if (disposed) return;
            disposed = true;
            yield* cleanupLocalStackResources({ stack, info, config });
          });

        const stack: StackService = {
          getInfo: () => Effect.succeed(info),
          start: () =>
            Effect.gen(function* () {
              yield* orchestrator.start();
              yield* orchestrator.waitAllReady();
            }),
          stop: () => orchestrator.stop(),
          dispose: disposeOnce,
          startService: (name) =>
            Effect.gen(function* () {
              yield* orchestrator.startService(name);
              yield* orchestrator.waitReady(name);
            }),
          stopService: (name) => orchestrator.stopService(name),
          restartService: (name) => orchestrator.restartService(name),
          getState: (name) => orchestrator.getState(name),
          getAllStates: () => orchestrator.getAllStates(),
          stateChanges: (name) => orchestrator.stateChanges(name),
          allStateChanges: () => orchestrator.allStateChanges(),
          waitReady: (name) => orchestrator.waitReady(name),
          waitAllReady: () => orchestrator.waitAllReady(),
          subscribeLogs: (name) => logBuffer.subscribe(name),
          subscribeAllLogs: (services) =>
            services === undefined || services.length === 0
              ? logBuffer.subscribeAll()
              : logBuffer
                  .subscribeAll()
                  .pipe(Stream.filter((entry) => services.includes(entry.service))),
          logHistory: (name, limit) => logBuffer.history(name, limit),
          logHistoryAll: (limit, services) => logBuffer.historyAll(limit, services),
        };

        yield* Effect.addFinalizer(disposeOnce);

        return stack;
      }),
    );
}
