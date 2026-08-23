import { Schema } from "effect";

const ControlOwnerStateSchema = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "deleting",
  "failed",
]);

export const CONTROL_PROTOCOL = "supabase-stack-control" as const;
export const CONTROL_PROTOCOL_VERSION = 1 as const;

export type ControlOwnerState = typeof ControlOwnerStateSchema.Type;

export const ControlOwnerStatusSchema = Schema.Struct({
  controlProtocol: Schema.Literal(CONTROL_PROTOCOL),
  controlProtocolVersion: Schema.Literal(CONTROL_PROTOCOL_VERSION),
  ownershipId: Schema.String,
  ownerSessionId: Schema.String,
  state: ControlOwnerStateSchema,
  ready: Schema.Boolean,
  daemonCliVersion: Schema.String,
  daemonBuildId: Schema.String,
});

export type ControlOwnerStatus = typeof ControlOwnerStatusSchema.Type;

export const ControlStopRequestSchema = Schema.Struct({
  ownershipId: Schema.String,
  ownerSessionId: Schema.String,
});

export type ControlStopRequest = typeof ControlStopRequestSchema.Type;
