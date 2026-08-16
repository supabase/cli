import { Schema } from "effect";
import { StackStateSchema } from "./StateManager.ts";

const DaemonErrorCodeSchema = Schema.Literals([
  "SERVICE_NOT_FOUND",
  "SERVICE_NOT_READY",
  "STACK_READINESS_TIMEOUT",
  "STACK_BUILD_ERROR",
]);

const StackBuildReasonSchema = Schema.Literals([
  "invalid_config",
  "docker_not_running",
  "asset_preparation",
]);

export const ControlOwnerStateSchema = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "deleting",
  "failed",
]);

export type ControlOwnerState = typeof ControlOwnerStateSchema.Type;

export const ControlOwnerStatusSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  ownershipId: Schema.String,
  state: ControlOwnerStateSchema,
  ready: Schema.Boolean,
});

export type ControlOwnerStatus = typeof ControlOwnerStatusSchema.Type;

// Daemon-prefixed aliases keep the protocol vocabulary discoverable alongside
// the existing DaemonErrorResponse and DaemonMessage schemas.
export const DaemonOwnerStateSchema = ControlOwnerStateSchema;
export type DaemonOwnerState = ControlOwnerState;
export const DaemonOwnerStatusSchema = ControlOwnerStatusSchema;
export type DaemonOwnerStatus = ControlOwnerStatus;

export const DaemonErrorResponseSchema = Schema.Struct({
  code: DaemonErrorCodeSchema,
  error: Schema.String,
  service: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  timeoutMs: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(StackBuildReasonSchema),
});

export type DaemonErrorResponse = typeof DaemonErrorResponseSchema.Type;

export const DaemonMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("started"), state: StackStateSchema }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
