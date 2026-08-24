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

export const ControlOwnerDescriptorSchema = Schema.Struct({
  controlProtocol: Schema.Literal(CONTROL_PROTOCOL),
  controlProtocolVersion: Schema.Literal(CONTROL_PROTOCOL_VERSION),
  ownershipId: Schema.String,
  ownerSessionId: Schema.String,
  daemonCliVersion: Schema.String,
});

export const ControlOwnerStatusSchema = Schema.Struct({
  ...ControlOwnerDescriptorSchema.fields,
  state: ControlOwnerStateSchema,
  ready: Schema.Boolean,
});

export type ControlOwnerStatus = typeof ControlOwnerStatusSchema.Type;

export const ControlStopRequestSchema = Schema.Struct({
  ownershipId: Schema.String,
  ownerSessionId: Schema.String,
});

export type ControlStopRequest = typeof ControlStopRequestSchema.Type;
