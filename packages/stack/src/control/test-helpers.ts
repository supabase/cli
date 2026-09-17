import { Effect, Stream } from "effect";
import type { StackRpcError, StackRpcHandlers } from "./StackRpc.ts";

const unavailable: StackRpcError = {
  tag: "StackStateInvalidError",
  message: "Service RPC is not configured in this transport fixture",
};

/** Completes unconfigured stack RPCs while focused tests replace the operation under test. */
export const unconfiguredStackRpcHandlers: Pick<
  StackRpcHandlers,
  | "status"
  | "followStatus"
  | "credentials"
  | "start"
  | "sleep"
  | "stop"
  | "restart"
  | "destroy"
  | "logs"
> = {
  status: () => Effect.fail(unavailable),
  followStatus: () => Stream.fail(unavailable),
  credentials: () => Effect.fail(unavailable),
  start: () => Effect.fail(unavailable),
  sleep: () => Effect.fail(unavailable),
  stop: () => Effect.fail(unavailable),
  restart: () => Effect.fail(unavailable),
  destroy: () => Effect.void,
  logs: () => Effect.fail(unavailable),
};

/** Completes unconfigured service RPCs while focused tests replace the operation under test. */
export const unconfiguredServiceRpcHandlers: Pick<
  StackRpcHandlers,
  | "servicesCreate"
  | "servicesGet"
  | "servicesList"
  | "serviceStatus"
  | "serviceFollowStatus"
  | "serviceStart"
  | "serviceSleep"
  | "serviceStop"
  | "serviceDestroy"
  | "servicePrepare"
  | "serviceRestart"
  | "serviceCredentials"
  | "serviceLogs"
  | "serviceExportSnapshot"
  | "serviceRestoreSnapshot"
> = {
  servicesCreate: () => Effect.fail(unavailable),
  servicesGet: () => Effect.fail(unavailable),
  servicesList: () => Effect.fail(unavailable),
  serviceStatus: () => Effect.fail(unavailable),
  serviceFollowStatus: () => Stream.fail(unavailable),
  serviceStart: () => Effect.fail(unavailable),
  serviceSleep: () => Effect.fail(unavailable),
  serviceStop: () => Effect.fail(unavailable),
  serviceDestroy: () => Effect.fail(unavailable),
  servicePrepare: () => Effect.fail(unavailable),
  serviceRestart: () => Effect.fail(unavailable),
  serviceCredentials: () => Effect.fail(unavailable),
  serviceLogs: () => Effect.fail(unavailable),
  serviceExportSnapshot: () => Effect.fail(unavailable),
  serviceRestoreSnapshot: () => Effect.fail(unavailable),
};
