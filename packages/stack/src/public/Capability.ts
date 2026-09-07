import { Schema } from "effect";

export const CAPABILITY_NAMES = [
  "database",
  "rest",
  "auth",
  "realtime",
  "storage",
  "functions",
  "studio",
  "mail",
  "analytics",
  "pooler",
] as const;

export const CapabilityNameSchema = Schema.Literals(CAPABILITY_NAMES);
export type CapabilityName = Schema.Schema.Type<typeof CapabilityNameSchema>;

export const CapabilityStateSchema = Schema.Literals([
  "disabled",
  "dormant",
  "starting",
  "ready",
  "stopped",
  "failed",
] as const);
export type CapabilityState = Schema.Schema.Type<typeof CapabilityStateSchema>;

export const ActivationModeSchema = Schema.Literals(["eager", "lazy"] as const);
export type ActivationMode = Schema.Schema.Type<typeof ActivationModeSchema>;

export const CapabilityStatusSchema = Schema.Struct({
  name: CapabilityNameSchema,
  activation: ActivationModeSchema,
  state: CapabilityStateSchema,
  error: Schema.optionalKey(Schema.String),
});
export type CapabilityStatus = Schema.Schema.Type<typeof CapabilityStatusSchema>;
