import { ServiceNotFoundError } from "@supabase/process-compose";
import type { LogEntry, ServiceReadyError } from "@supabase/process-compose";
import { Effect, Layer, Schema, Context, Stream } from "effect";
import { StackBuildError } from "./errors.ts";
import type { FunctionsConfig } from "./functions.ts";
import { StackLifecycleCoordinator } from "./StackLifecycleCoordinator.ts";
import type { EdgeRuntimeConfig, ResolvedStackConfig } from "./StackBuilder.ts";
import { StackServiceState } from "./StackServiceState.ts";

export interface StackInfo {
  readonly url: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly anonJwt: string;
  readonly serviceRoleJwt: string;
  readonly serviceEndpoints: Readonly<Record<string, string>>;
}

export const StackInfoSchema = Schema.Struct({
  url: Schema.String,
  dbUrl: Schema.String,
  publishableKey: Schema.String,
  secretKey: Schema.String,
  anonJwt: Schema.String,
  serviceRoleJwt: Schema.String,
  serviceEndpoints: Schema.Record(Schema.String, Schema.String),
});

const EdgeRuntimeConfigSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  inspectorPort: Schema.optionalKey(Schema.Number),
  policy: Schema.optionalKey(Schema.Literals(["oneshot", "per_worker"])),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const FunctionsConfigSchema = Schema.Struct({
  envFile: Schema.optionalKey(Schema.String),
  noVerifyJwt: Schema.optionalKey(Schema.Boolean),
});

export const EdgeRuntimeReloadConfigSchema = Schema.Struct({
  edgeRuntime: EdgeRuntimeConfigSchema,
  functions: Schema.optionalKey(FunctionsConfigSchema),
});

export interface EdgeRuntimeReloadConfig {
  readonly edgeRuntime: EdgeRuntimeConfig;
  readonly functions?: FunctionsConfig;
}

type StackService = typeof Stack.Service;

export class Stack extends Context.Service<
  Stack,
  {
    readonly getInfo: () => Effect.Effect<StackInfo>;
    readonly start: () => Effect.Effect<void, ServiceReadyError | StackBuildError>;
    readonly stop: () => Effect.Effect<void>;
    readonly dispose: () => Effect.Effect<void>;
    readonly startService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>;
    readonly stopService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | StackBuildError>;
    readonly restartService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | StackBuildError>;
    readonly reloadFunctions: (
      opts?: FunctionsConfig,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>;
    readonly reloadEdgeRuntime: (
      opts: EdgeRuntimeReloadConfig,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>;
    readonly getState: (name: string) => Effect.Effect<StackServiceState, ServiceNotFoundError>;
    readonly getAllStates: () => Effect.Effect<ReadonlyArray<StackServiceState>>;
    readonly stateChanges: (
      name: string,
    ) => Effect.Effect<Stream.Stream<StackServiceState>, ServiceNotFoundError>;
    readonly allStateChanges: () => Stream.Stream<StackServiceState>;
    readonly waitReady: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | ServiceReadyError | StackBuildError>;
    readonly waitAllReady: () => Effect.Effect<void, ServiceReadyError | StackBuildError>;
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
    _config: ResolvedStackConfig,
  ): Layer.Layer<Stack, StackBuildError, StackLifecycleCoordinator> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const coordinator = yield* StackLifecycleCoordinator;
        return {
          getInfo: coordinator.getInfo,
          start: coordinator.start,
          stop: coordinator.stop,
          dispose: coordinator.dispose,
          startService: coordinator.startService,
          stopService: coordinator.stopService,
          restartService: coordinator.restartService,
          reloadFunctions: coordinator.reloadFunctions,
          reloadEdgeRuntime: coordinator.reloadEdgeRuntime,
          getState: coordinator.getState,
          getAllStates: coordinator.getAllStates,
          stateChanges: coordinator.stateChanges,
          allStateChanges: coordinator.allStateChanges,
          waitReady: coordinator.waitReady,
          waitAllReady: coordinator.waitAllReady,
          subscribeLogs: coordinator.subscribeLogs,
          subscribeAllLogs: coordinator.subscribeAllLogs,
          logHistory: coordinator.logHistory,
          logHistoryAll: coordinator.logHistoryAll,
        } satisfies StackService;
      }),
    );
}
