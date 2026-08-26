import { Schema } from "effect";

export const ControlOwnerStateSchema = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "deleting",
  "failed",
]);

export const CONTROL_PROTOCOL = "supabase-stack-control" as const;
export const CONTROL_PROTOCOL_VERSION = 1 as const;

export type ControlOwnerState = typeof ControlOwnerStateSchema.Type;

const ControlOwnerIdentitySchema = Schema.Struct({
  controlProtocol: Schema.Literal(CONTROL_PROTOCOL),
  controlProtocolVersion: Schema.Literal(CONTROL_PROTOCOL_VERSION),
  ownershipId: Schema.String,
  ownerSessionId: Schema.String,
});

export const ControlSupervisorDescriptorSchema = Schema.Struct({
  ...ControlOwnerIdentitySchema.fields,
  kind: Schema.Literal("supervisor"),
  daemonCliVersion: Schema.String,
});

const ControlMaintenanceDescriptorSchema = Schema.Struct({
  ...ControlOwnerIdentitySchema.fields,
  kind: Schema.Literal("maintenance"),
  operation: Schema.Literals(["delete", "stop", "update", "repair"]),
});

const ControlSupervisorStatusSchema = Schema.Struct({
  ...ControlSupervisorDescriptorSchema.fields,
  state: ControlOwnerStateSchema,
  ready: Schema.Boolean,
});

const ControlMaintenanceStatusSchema = Schema.Struct({
  ...ControlMaintenanceDescriptorSchema.fields,
});

export const ControlOwnerStatusSchema = Schema.Union([
  ControlSupervisorStatusSchema,
  ControlMaintenanceStatusSchema,
]);

export type ControlOwnerStatus = typeof ControlOwnerStatusSchema.Type;
export type ControlSupervisorStatus = typeof ControlSupervisorStatusSchema.Type;
export type ControlMaintenanceOperation =
  (typeof ControlMaintenanceDescriptorSchema.Type)["operation"];

export const isControlSupervisorStatus = (
  status: ControlOwnerStatus,
): status is ControlSupervisorStatus => status.kind === "supervisor";

export const ControlStopRequestSchema = Schema.Struct({
  ownershipId: Schema.String,
  ownerSessionId: Schema.String,
  intent: Schema.Literals(["explicit", "replacement"]),
});

export type ControlStopRequest = typeof ControlStopRequestSchema.Type;
export type ControlStopIntent = ControlStopRequest["intent"];
