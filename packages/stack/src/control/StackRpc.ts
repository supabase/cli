import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { EffectStackCredentialsSchema } from "../public/Credentials.ts";
import { StackRestartPayloadSchema } from "../public/Config.ts";
import { LogQuerySchema, ServiceLogQuerySchema, StackLogBatchSchema } from "../public/Logs.ts";
import { StackRecoverySchema, StackStatusSchema } from "../public/Status.ts";
import { StackIdSchema } from "../public/StackId.ts";
import { STACK_ERROR_TAGS } from "../public/Errors.ts";
import { ServiceInstanceIdSchema } from "../public/ServiceInstanceId.ts";
import {
  EffectCreateServiceOptionsSchema,
  ServiceRestartPayloadSchema,
} from "../public/Service.ts";
import {
  PrepareResultSchema,
  ServiceCredentialsSchema,
  ServiceDescriptorListSchema,
  ServiceDescriptorSchema,
  ServiceStatusSchema,
  SnapshotDescriptorSchema,
} from "./ServiceProtocol.ts";

const LifecycleOutcomeSchema = Schema.Struct({
  requested: Schema.Array(Schema.String),
  affected: Schema.Array(Schema.String),
  succeeded: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
  statuses: Schema.optionalKey(Schema.Array(ServiceStatusSchema)),
  recovery: Schema.optionalKey(StackRecoverySchema),
  removed: Schema.optionalKey(Schema.Array(Schema.String)),
  retained: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** Pinned release identifier used to detect incompatible live owners. */
export const STACK_RPC_RELEASE = "stack-rpc-v1@0.3.0" as const;

const StackRpcErrorTagSchema = Schema.Literals([...STACK_ERROR_TAGS] as const);

const StackRpcErrorSchema = Schema.Struct({
  tag: StackRpcErrorTagSchema,
  message: Schema.String,
  stackId: Schema.optionalKey(StackIdSchema),
  instanceId: Schema.optionalKey(Schema.String),
  ownerSessionId: Schema.optionalKey(Schema.String),
  operationId: Schema.optionalKey(Schema.String),
  expectedCreationInputsId: Schema.optionalKey(Schema.String),
  mutation: Schema.optionalKey(
    Schema.Literals([
      "create",
      "restore",
      "start",
      "sleep",
      "stop",
      "restart",
      "destroy",
      "exportSnapshot",
    ] as const),
  ),
  outcome: Schema.optionalKey(LifecycleOutcomeSchema),
});
export type StackRpcError = Schema.Schema.Type<typeof StackRpcErrorSchema>;

const StackRpc = {
  servicesCreate: Rpc.make("servicesCreate", {
    payload: EffectCreateServiceOptionsSchema,
    success: ServiceDescriptorSchema,
    error: StackRpcErrorSchema,
  }),
  servicesGet: Rpc.make("servicesGet", {
    payload: Schema.Union([
      Schema.Struct({ id: ServiceInstanceIdSchema }),
      Schema.Struct({ name: Schema.String.check(Schema.isNonEmpty()) }),
    ]),
    success: ServiceDescriptorSchema,
    error: StackRpcErrorSchema,
  }),
  servicesList: Rpc.make("servicesList", {
    success: ServiceDescriptorListSchema,
    error: StackRpcErrorSchema,
  }),
  serviceStatus: Rpc.make("serviceStatus", {
    payload: Schema.Struct({ id: ServiceInstanceIdSchema }),
    success: ServiceStatusSchema,
    error: StackRpcErrorSchema,
  }),
  serviceFollowStatus: Rpc.make("serviceFollowStatus", {
    payload: Schema.Struct({ id: ServiceInstanceIdSchema }),
    success: ServiceStatusSchema,
    error: StackRpcErrorSchema,
    stream: true,
  }),
  serviceStart: Rpc.make("serviceStart", {
    payload: Schema.Struct({ id: ServiceInstanceIdSchema }),
    success: ServiceStatusSchema,
    error: StackRpcErrorSchema,
  }),
  serviceSleep: Rpc.make("serviceSleep", {
    payload: Schema.Struct({ id: ServiceInstanceIdSchema }),
    success: ServiceStatusSchema,
    error: StackRpcErrorSchema,
  }),
  serviceStop: Rpc.make("serviceStop", {
    payload: Schema.Struct({ id: ServiceInstanceIdSchema }),
    success: ServiceStatusSchema,
    error: StackRpcErrorSchema,
  }),
  serviceDestroy: Rpc.make("serviceDestroy", {
    payload: Schema.Struct({ id: ServiceInstanceIdSchema }),
    success: Schema.Void,
    error: StackRpcErrorSchema,
  }),
  servicePrepare: Rpc.make("servicePrepare", {
    payload: Schema.Struct({ id: ServiceInstanceIdSchema }),
    success: PrepareResultSchema,
    error: StackRpcErrorSchema,
  }),
  serviceRestart: Rpc.make("serviceRestart", {
    payload: ServiceRestartPayloadSchema,
    success: ServiceStatusSchema,
    error: StackRpcErrorSchema,
  }),
  serviceCredentials: Rpc.make("serviceCredentials", {
    payload: Schema.Struct({ id: ServiceInstanceIdSchema }),
    success: ServiceCredentialsSchema,
    error: StackRpcErrorSchema,
  }),
  serviceLogs: Rpc.make("serviceLogs", {
    payload: Schema.Struct({
      id: ServiceInstanceIdSchema,
      query: Schema.optionalKey(ServiceLogQuerySchema),
    }),
    success: StackLogBatchSchema,
    error: StackRpcErrorSchema,
  }),
  serviceExportSnapshot: Rpc.make("serviceExportSnapshot", {
    payload: Schema.Struct({ id: ServiceInstanceIdSchema, destination: Schema.String }),
    success: SnapshotDescriptorSchema,
    error: StackRpcErrorSchema,
  }),
  serviceRestoreSnapshot: Rpc.make("serviceRestoreSnapshot", {
    payload: Schema.Struct({ id: ServiceInstanceIdSchema, source: Schema.String }),
    success: SnapshotDescriptorSchema,
    error: StackRpcErrorSchema,
  }),
  status: Rpc.make("status", { success: StackStatusSchema, error: StackRpcErrorSchema }),
  followStatus: Rpc.make("followStatus", {
    success: StackStatusSchema,
    error: StackRpcErrorSchema,
    stream: true,
  }),
  credentials: Rpc.make("credentials", {
    success: EffectStackCredentialsSchema,
    error: StackRpcErrorSchema,
  }),
  start: Rpc.make("start", {
    payload: Schema.Struct({
      services: Schema.optionalKey(Schema.Array(ServiceInstanceIdSchema)),
    }),
    success: StackStatusSchema,
    error: StackRpcErrorSchema,
  }),
  sleep: Rpc.make("sleep", {
    payload: Schema.Struct({ services: Schema.optionalKey(Schema.Array(ServiceInstanceIdSchema)) }),
    success: StackStatusSchema,
    error: StackRpcErrorSchema,
  }),
  stop: Rpc.make("stop", {
    payload: Schema.Struct({ services: Schema.optionalKey(Schema.Array(ServiceInstanceIdSchema)) }),
    success: StackStatusSchema,
    error: StackRpcErrorSchema,
  }),
  restart: Rpc.make("restart", {
    payload: StackRestartPayloadSchema,
    success: StackStatusSchema,
    error: StackRpcErrorSchema,
  }),
  destroy: Rpc.make("destroy", {
    payload: Schema.Struct({
      services: Schema.optionalKey(Schema.Array(ServiceInstanceIdSchema)),
    }),
    success: Schema.Void,
    error: StackRpcErrorSchema,
  }),
  logs: Rpc.make("logs", {
    payload: LogQuerySchema,
    success: StackLogBatchSchema,
    error: StackRpcErrorSchema,
  }),
} as const;

export const StackRpcGroup = RpcGroup.make(
  StackRpc.servicesCreate,
  StackRpc.servicesGet,
  StackRpc.servicesList,
  StackRpc.serviceStatus,
  StackRpc.serviceFollowStatus,
  StackRpc.serviceStart,
  StackRpc.serviceSleep,
  StackRpc.serviceStop,
  StackRpc.serviceDestroy,
  StackRpc.servicePrepare,
  StackRpc.serviceRestart,
  StackRpc.serviceCredentials,
  StackRpc.serviceLogs,
  StackRpc.serviceExportSnapshot,
  StackRpc.serviceRestoreSnapshot,
  StackRpc.status,
  StackRpc.followStatus,
  StackRpc.credentials,
  StackRpc.start,
  StackRpc.stop,
  StackRpc.sleep,
  StackRpc.restart,
  StackRpc.destroy,
  StackRpc.logs,
);
type StackRpcDefinitions = RpcGroup.Rpcs<typeof StackRpcGroup>;
export type StackRpcHandlers = {
  readonly [Current in StackRpcDefinitions as Current["_tag"]]: Rpc.ToHandlerFn<Current, never>;
};
export type StackRpcClient = RpcClient.FromGroup<typeof StackRpcGroup, RpcClientError>;

export const releaseMismatch = (actualRelease: string): string =>
  `Incompatible Stack RPC release; expected ${STACK_RPC_RELEASE}, received ${actualRelease}`;
