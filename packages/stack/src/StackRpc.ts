import { Schema, SchemaTransformation } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ServiceNotFoundError, ServiceReadyError } from "@supabase/process-compose";
import {
  StackBuildError,
  StackNotRunningError,
  StackReadinessError,
  StackUnavailableError,
} from "./errors.ts";
import { StackInfoSchema } from "./Stack.ts";
import { StackServiceStatusSchema } from "./StackServiceState.ts";
import { ResolvedFunctionsBundleSchema } from "./functions.ts";
import { ReadyOptionsSchema } from "./StackConfig.ts";
import { matchesControlSession, type ControlSessionFence } from "./DaemonProtocol.ts";

/** Headers that fence same-version RPC calls to one observed supervisor session. */
const STACK_RPC_FENCE_HEADERS = {
  ownershipId: "x-supabase-stack-ownership-id",
  ownerSessionId: "x-supabase-stack-owner-session-id",
} as const;

export type StackRpcFence = ControlSessionFence;

export const stackRpcFenceHeaders = (fence: StackRpcFence): Readonly<Record<string, string>> => ({
  [STACK_RPC_FENCE_HEADERS.ownershipId]: fence.ownershipId,
  [STACK_RPC_FENCE_HEADERS.ownerSessionId]: fence.ownerSessionId,
});

export const matchesStackRpcFence = (
  headers: Readonly<Record<string, string>>,
  expected: StackRpcFence,
): boolean =>
  matchesControlSession(
    {
      ownershipId: headers[STACK_RPC_FENCE_HEADERS.ownershipId] ?? "",
      ownerSessionId: headers[STACK_RPC_FENCE_HEADERS.ownerSessionId] ?? "",
    },
    expected,
  );

const StackUnavailableErrorSchema = Schema.TaggedStruct("StackUnavailableError", {
  phase: Schema.Literals(["starting", "stopping", "failed"]),
  detail: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.decodeTo(
    Schema.instanceOf(StackUnavailableError),
    SchemaTransformation.transform({
      decode: (value) => new StackUnavailableError(value),
      encode: (value) => value,
    }),
  ),
);

const ServiceNotFoundErrorSchema = Schema.TaggedStruct("ServiceNotFoundError", {
  name: Schema.String,
}).pipe(
  Schema.decodeTo(
    Schema.instanceOf(ServiceNotFoundError),
    SchemaTransformation.transform({
      decode: (value) => new ServiceNotFoundError(value),
      encode: (value) => value,
    }),
  ),
);

const ServiceReadyErrorSchema = Schema.TaggedStruct("ServiceReadyError", {
  name: Schema.String,
  reason: Schema.String,
  exitCode: Schema.optionalKey(Schema.Number),
}).pipe(
  Schema.decodeTo(
    Schema.instanceOf(ServiceReadyError),
    SchemaTransformation.transform({
      decode: (value) => new ServiceReadyError(value),
      encode: (value) => value,
    }),
  ),
);

const StackBuildErrorSchema = Schema.TaggedStruct("StackBuildError", {
  detail: Schema.String,
  reason: Schema.optionalKey(
    Schema.Literals(["invalid_config", "docker_not_running", "asset_preparation"]),
  ),
}).pipe(
  Schema.decodeTo(
    Schema.instanceOf(StackBuildError),
    SchemaTransformation.transform({
      decode: (value) => new StackBuildError(value),
      encode: (value) => value,
    }),
  ),
);

const StackNotRunningErrorSchema = Schema.TaggedStruct("StackNotRunningError", {
  phase: Schema.String,
}).pipe(
  Schema.decodeTo(
    Schema.instanceOf(StackNotRunningError),
    SchemaTransformation.transform({
      decode: (value) => new StackNotRunningError(value),
      encode: (value) => value,
    }),
  ),
);

const StackReadinessErrorSchema = Schema.TaggedStruct("StackReadinessError", {
  target: Schema.String,
  timeoutMs: Schema.Number,
  detail: Schema.String,
}).pipe(
  Schema.decodeTo(
    Schema.instanceOf(StackReadinessError),
    SchemaTransformation.transform({
      decode: (value) => new StackReadinessError(value),
      encode: (value) => value,
    }),
  ),
);

const buildReadyErrors = Schema.Union([
  StackUnavailableErrorSchema,
  ServiceReadyErrorSchema,
  StackBuildErrorSchema,
  StackReadinessErrorSchema,
]);
const serviceReadyErrors = Schema.Union([
  StackUnavailableErrorSchema,
  ServiceNotFoundErrorSchema,
  ServiceReadyErrorSchema,
  StackBuildErrorSchema,
  StackReadinessErrorSchema,
]);
const serviceMutatingErrors = Schema.Union([
  StackUnavailableErrorSchema,
  ServiceNotFoundErrorSchema,
  ServiceReadyErrorSchema,
  StackBuildErrorSchema,
  StackNotRunningErrorSchema,
  StackReadinessErrorSchema,
]);
const stopServiceErrors = Schema.Union([
  StackUnavailableErrorSchema,
  ServiceNotFoundErrorSchema,
  StackBuildErrorSchema,
  StackNotRunningErrorSchema,
]);
const serviceStateErrors = Schema.Union([StackUnavailableErrorSchema, ServiceNotFoundErrorSchema]);
const updateLaunchErrors = Schema.Union([StackUnavailableErrorSchema, StackBuildErrorSchema]);

const StackServiceStateSchema = Schema.Struct({
  name: Schema.String,
  status: StackServiceStatusSchema,
  pid: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
  restartCount: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
});

const StackLogEntrySchema = Schema.Struct({
  timestamp: Schema.Number,
  service: Schema.String,
  stream: Schema.Union([Schema.Literal("stdout"), Schema.Literal("stderr")]),
  line: Schema.String,
});

const ReadyOptionsRpcSchema = ReadyOptionsSchema;

const EdgeRuntimeReloadRpcSchema = Schema.Struct({
  edgeRuntime: Schema.Struct({
    enabled: Schema.optionalKey(Schema.Boolean),
    inspectorPort: Schema.optionalKey(Schema.Number),
    policy: Schema.optionalKey(Schema.Literals(["oneshot", "per_worker"])),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  functions: Schema.optionalKey(ResolvedFunctionsBundleSchema),
});

const StackLaunchUpdateRpcSchema = Schema.Struct({
  versions: Schema.Record(Schema.String, Schema.String),
  excludedServices: Schema.optionalKey(Schema.Array(Schema.String)),
  lastNotifiedUpdateFingerprint: Schema.optionalKey(Schema.String),
});
export type StackLaunchUpdateRpc = typeof StackLaunchUpdateRpcSchema.Type;

/** One same-version RPC contract for every runtime operation. */
export const StackRpc = RpcGroup.make(
  Rpc.make("GetInfo", { success: StackInfoSchema, error: StackUnavailableErrorSchema }),
  Rpc.make("StartStack", { success: Schema.Void, error: buildReadyErrors }),
  Rpc.make("StartService", {
    payload: { name: Schema.String },
    success: Schema.Void,
    error: serviceMutatingErrors,
  }),
  Rpc.make("StopService", {
    payload: { name: Schema.String },
    success: Schema.Void,
    error: stopServiceErrors,
  }),
  Rpc.make("RestartService", {
    payload: { name: Schema.String },
    success: Schema.Void,
    error: serviceMutatingErrors,
  }),
  Rpc.make("WaitStackReady", {
    payload: { options: Schema.optionalKey(ReadyOptionsRpcSchema) },
    success: Schema.Void,
    error: buildReadyErrors,
  }),
  Rpc.make("WaitServiceReady", {
    payload: { name: Schema.String, options: Schema.optionalKey(ReadyOptionsRpcSchema) },
    success: Schema.Void,
    error: serviceReadyErrors,
  }),
  Rpc.make("ReloadFunctions", {
    payload: {
      options: Schema.optionalKey(
        Schema.Struct({ functions: Schema.optionalKey(ResolvedFunctionsBundleSchema) }),
      ),
    },
    success: Schema.Void,
    error: serviceMutatingErrors,
  }),
  Rpc.make("ReloadEdgeRuntime", {
    payload: EdgeRuntimeReloadRpcSchema,
    success: Schema.Void,
    error: serviceMutatingErrors,
  }),
  Rpc.make("UpdateLaunch", {
    payload: { stackId: Schema.String, launch: StackLaunchUpdateRpcSchema },
    success: Schema.Void,
    error: updateLaunchErrors,
  }),
  Rpc.make("GetServiceState", {
    payload: { name: Schema.String },
    success: StackServiceStateSchema,
    error: serviceStateErrors,
  }),
  Rpc.make("GetAllServiceStates", {
    success: Schema.Array(StackServiceStateSchema),
    error: StackUnavailableErrorSchema,
  }),
  Rpc.make("WatchServiceStates", {
    payload: { name: Schema.optionalKey(Schema.String) },
    success: StackServiceStateSchema,
    error: serviceStateErrors,
    stream: true,
  }),
  Rpc.make("GetLogHistory", {
    payload: {
      name: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Number),
      services: Schema.optionalKey(Schema.Array(Schema.String)),
    },
    success: Schema.Array(StackLogEntrySchema),
    error: serviceStateErrors,
  }),
  Rpc.make("WatchLogs", {
    payload: {
      name: Schema.optionalKey(Schema.String),
      services: Schema.optionalKey(Schema.Array(Schema.String)),
    },
    success: StackLogEntrySchema,
    error: serviceStateErrors,
    stream: true,
  }),
);

export const STACK_RPC_PATH = "/rpc" as const;
