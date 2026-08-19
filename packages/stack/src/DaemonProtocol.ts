import { Schema } from "effect";

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

const ControlOwnerStateSchema = Schema.Literals([
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

export const DaemonErrorResponseSchema = Schema.Struct({
  code: DaemonErrorCodeSchema,
  error: Schema.String,
  service: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  timeoutMs: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(StackBuildReasonSchema),
});

export type DaemonErrorResponse = typeof DaemonErrorResponseSchema.Type;
