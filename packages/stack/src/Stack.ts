import { ServiceNotFoundError } from "@supabase/process-compose";
import type { LogEntry, ServiceReadyError } from "@supabase/process-compose";
import { Context, Effect, Schema, Stream } from "effect";
import { StackBuildError, StackReadinessError } from "./errors.ts";
import {
  ResolvedFunctionsBundleSchema,
  type FunctionsReloadConfig,
  type ResolvedFunctionsBundle,
} from "./functions.ts";
import type { EdgeRuntimeConfig, ReadyOptions } from "./StackConfig.ts";
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

export const EdgeRuntimeReloadConfigSchema = Schema.Struct({
  edgeRuntime: EdgeRuntimeConfigSchema,
  functions: Schema.optionalKey(ResolvedFunctionsBundleSchema),
});

export interface EdgeRuntimeReloadConfig {
  readonly edgeRuntime: EdgeRuntimeConfig;
  readonly functions?: ResolvedFunctionsBundle;
}

export class Stack extends Context.Service<
  Stack,
  {
    readonly getInfo: () => Effect.Effect<StackInfo>;
    readonly start: () => Effect.Effect<
      void,
      ServiceReadyError | StackBuildError | StackReadinessError
    >;
    readonly stop: () => Effect.Effect<void>;
    readonly dispose: () => Effect.Effect<void>;
    readonly startService: (
      name: string,
    ) => Effect.Effect<
      void,
      ServiceNotFoundError | ServiceReadyError | StackBuildError | StackReadinessError
    >;
    readonly stopService: (
      name: string,
    ) => Effect.Effect<void, ServiceNotFoundError | StackBuildError>;
    readonly restartService: (
      name: string,
    ) => Effect.Effect<
      void,
      ServiceNotFoundError | ServiceReadyError | StackBuildError | StackReadinessError
    >;
    readonly reloadFunctions: (
      opts?: FunctionsReloadConfig,
    ) => Effect.Effect<
      void,
      ServiceNotFoundError | ServiceReadyError | StackBuildError | StackReadinessError
    >;
    readonly reloadEdgeRuntime: (
      opts: EdgeRuntimeReloadConfig,
    ) => Effect.Effect<
      void,
      ServiceNotFoundError | ServiceReadyError | StackBuildError | StackReadinessError
    >;
    readonly getState: (name: string) => Effect.Effect<StackServiceState, ServiceNotFoundError>;
    readonly getAllStates: () => Effect.Effect<ReadonlyArray<StackServiceState>>;
    readonly stateChanges: (
      name: string,
    ) => Effect.Effect<Stream.Stream<StackServiceState>, ServiceNotFoundError>;
    readonly allStateChanges: () => Stream.Stream<StackServiceState>;
    readonly waitReady: (
      name: string,
      opts?: ReadyOptions,
    ) => Effect.Effect<
      void,
      ServiceNotFoundError | ServiceReadyError | StackBuildError | StackReadinessError
    >;
    readonly waitAllReady: (
      opts?: ReadyOptions,
    ) => Effect.Effect<void, ServiceReadyError | StackBuildError | StackReadinessError>;
    readonly subscribeLogs: (name: string) => Stream.Stream<LogEntry>;
    readonly subscribeAllLogs: (services?: ReadonlyArray<string>) => Stream.Stream<LogEntry>;
    readonly logHistory: (name: string, limit?: number) => Effect.Effect<ReadonlyArray<LogEntry>>;
    readonly logHistoryAll: (
      limit?: number,
      services?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LogEntry>>;
  }
>()("stack/Stack") {}
