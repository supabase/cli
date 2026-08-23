// oxlint-disable effecttsgo/lazy-effect -- Callable service methods intentionally re-evaluate lifecycle effects against current stack state.
import { ServiceNotFoundError } from "@supabase/process-compose";
import type { LogEntry, ServiceReadyError } from "@supabase/process-compose";
import { Context, Effect, Schema, Stream } from "effect";
import {
  StackBuildError,
  StackNotRunningError,
  StackReadinessError,
  StackRpcProtocolError,
  StackRpcTransportError,
  StackUnavailableError,
} from "./errors.ts";
import {
  ResolvedFunctionsBundleSchema,
  type FunctionsReloadConfig,
  type ResolvedFunctionsBundle,
} from "./functions.ts";
import type { EdgeRuntimeConfig, ReadyOptions } from "./StackConfig.ts";
import { StackServiceState } from "./StackServiceState.ts";
import type {
  ControlAddressConflictError,
  ControlProtocolError,
  ControlProtocolMismatchError,
  ControlTransportError,
} from "./managed/control.ts";
import type { StopTimeout } from "./errors.ts";

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
  inspectorPort: Schema.optionalKey(Schema.Finite),
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
    readonly getInfo: () => Effect.Effect<
      StackInfo,
      StackUnavailableError | StackRpcTransportError | StackRpcProtocolError
    >;
    readonly start: () => Effect.Effect<
      void,
      | ServiceReadyError
      | StackBuildError
      | StackReadinessError
      | StackUnavailableError
      | StackRpcTransportError
      | StackRpcProtocolError
    >;
    readonly stop: () => Effect.Effect<
      void,
      | ControlTransportError
      | ControlProtocolError
      | ControlProtocolMismatchError
      | ControlAddressConflictError
      | StopTimeout
    >;
    readonly dispose: () => Effect.Effect<
      void,
      | ControlTransportError
      | ControlProtocolError
      | ControlProtocolMismatchError
      | ControlAddressConflictError
      | StopTimeout
    >;
    readonly startService: (
      name: string,
    ) => Effect.Effect<
      void,
      | ServiceNotFoundError
      | ServiceReadyError
      | StackBuildError
      | StackNotRunningError
      | StackReadinessError
      | StackUnavailableError
      | StackRpcTransportError
      | StackRpcProtocolError
    >;
    readonly stopService: (
      name: string,
    ) => Effect.Effect<
      void,
      | ServiceNotFoundError
      | StackBuildError
      | StackNotRunningError
      | StackUnavailableError
      | StackRpcTransportError
      | StackRpcProtocolError
    >;
    readonly restartService: (
      name: string,
    ) => Effect.Effect<
      void,
      | ServiceNotFoundError
      | ServiceReadyError
      | StackBuildError
      | StackNotRunningError
      | StackReadinessError
      | StackUnavailableError
      | StackRpcTransportError
      | StackRpcProtocolError
    >;
    readonly reloadFunctions: (
      opts?: FunctionsReloadConfig,
    ) => Effect.Effect<
      void,
      | ServiceNotFoundError
      | ServiceReadyError
      | StackBuildError
      | StackNotRunningError
      | StackReadinessError
      | StackUnavailableError
      | StackRpcTransportError
      | StackRpcProtocolError
    >;
    readonly reloadEdgeRuntime: (
      opts: EdgeRuntimeReloadConfig,
    ) => Effect.Effect<
      void,
      | ServiceNotFoundError
      | ServiceReadyError
      | StackBuildError
      | StackNotRunningError
      | StackReadinessError
      | StackUnavailableError
      | StackRpcTransportError
      | StackRpcProtocolError
    >;
    readonly getState: (
      name: string,
    ) => Effect.Effect<
      StackServiceState,
      ServiceNotFoundError | StackUnavailableError | StackRpcTransportError | StackRpcProtocolError
    >;
    readonly getAllStates: () => Effect.Effect<
      ReadonlyArray<StackServiceState>,
      StackUnavailableError | StackRpcTransportError | StackRpcProtocolError
    >;
    readonly stateChanges: (
      name: string,
    ) => Effect.Effect<
      Stream.Stream<
        StackServiceState,
        | ServiceNotFoundError
        | StackUnavailableError
        | StackRpcTransportError
        | StackRpcProtocolError
      >,
      ServiceNotFoundError | StackUnavailableError | StackRpcTransportError | StackRpcProtocolError
    >;
    readonly allStateChanges: () => Stream.Stream<
      StackServiceState,
      StackUnavailableError | StackRpcTransportError | StackRpcProtocolError
    >;
    readonly waitReady: (
      name: string,
      opts?: ReadyOptions,
    ) => Effect.Effect<
      void,
      | ServiceNotFoundError
      | ServiceReadyError
      | StackBuildError
      | StackReadinessError
      | StackUnavailableError
      | StackRpcTransportError
      | StackRpcProtocolError
    >;
    readonly waitAllReady: (
      opts?: ReadyOptions,
    ) => Effect.Effect<
      void,
      | ServiceReadyError
      | StackBuildError
      | StackReadinessError
      | StackUnavailableError
      | StackRpcTransportError
      | StackRpcProtocolError
    >;
    readonly subscribeLogs: (
      name: string,
    ) => Stream.Stream<
      LogEntry,
      ServiceNotFoundError | StackUnavailableError | StackRpcTransportError | StackRpcProtocolError
    >;
    readonly subscribeAllLogs: (
      services?: ReadonlyArray<string>,
    ) => Stream.Stream<
      LogEntry,
      ServiceNotFoundError | StackUnavailableError | StackRpcTransportError | StackRpcProtocolError
    >;
    readonly logHistory: (
      name: string,
      limit?: number,
    ) => Effect.Effect<
      ReadonlyArray<LogEntry>,
      ServiceNotFoundError | StackUnavailableError | StackRpcTransportError | StackRpcProtocolError
    >;
    readonly logHistoryAll: (
      limit?: number,
      services?: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyArray<LogEntry>,
      ServiceNotFoundError | StackUnavailableError | StackRpcTransportError | StackRpcProtocolError
    >;
  }
>()("stack/Stack") {}
